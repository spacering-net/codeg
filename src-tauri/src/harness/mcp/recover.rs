//! What an installed item's own entries hold, read back into the parameters
//! of the option they were installed with — so that an update, which
//! rewrites the definition, can send the user's values again instead of
//! dropping them. The record keeps no values (some are secrets); the agents'
//! configs hold them.
//!
//! **A value is returned only when where it came from is certain.** Anything
//! that could have been written by more than one assignment of values to
//! parameters is reported as lost — the dialog then asks for it again —
//! never guessed: a guess could show a secret, or part of one, under a
//! parameter that is not secret.
//!
//! An entry is read against the shape it was written in: the option of the
//! **recorded revision** (its own server.json), not the one being installed.
//! What is read there is then carried to the new revision's option by name —
//! the same env variable, header or URL variable, or the package argument
//! with the same name — and only when the parameter is still there and its
//! secrecy has not changed. A recorded revision whose server.json cannot be
//! read, or an option that is not the same option in both (transport, kind,
//! package), carries nothing over.
//!
//! - stdio: `env` by name; the package's arguments by every way the
//!   converter could have written them (an optional argument without a
//!   default may be left out) — a parameter whose value is the same in every
//!   way the tokens can be read is certain, any other is lost;
//! - remote: `headers` by name; URL variables by matching the address
//!   against the template, taken only when the match can be made one way
//!   (placeholders side by side, or a separator a value may contain, make
//!   several), or from the query string for a variable the template has no
//!   place for (the converter appends those).

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use crate::commands::mcp::McpAppType;
use crate::commands::mcp_engine::model::{McpDefinition, McpTransport};

use super::convert::{analyze, parse_option_id, Analyzed};
use super::model::{
    LostValue, OptionRecovery, OptionSource, PlanOption, PlanParameter, RecoveredValue,
};

/// The most package arguments whose arrangements are worked through; more
/// is not read (all lost) rather than searched.
const MAX_ARGUMENTS: usize = 12;

/// The most arrangements of the arguments that are compared. Agreement is
/// only certainty over all of them: with more, nothing is read (all lost).
const MAX_ARRANGEMENTS: usize = 64;

/// One recorded revision's server.json and its options: the shape its
/// entries were written in.
pub(super) struct Schema {
    server: Value,
    options: Vec<Analyzed>,
}

impl Schema {
    pub fn new(server: Value) -> Self {
        let options = analyze(&server, &[]).unwrap_or_default();
        Self { server, options }
    }
}

/// One agent's entry of the installed item: the option the record says it
/// was installed with, the schema of the revision it was installed from
/// (`None`: that revision's server.json could not be read), and its
/// definition (`None`: not a server Codeg can describe).
pub(super) struct Source<'a> {
    pub agent: McpAppType,
    pub option: &'a str,
    pub schema: Option<&'a Schema>,
    pub definition: Option<&'a McpDefinition>,
}

/// An option as recovery reads it, whichever revision it is of.
struct Shape<'a> {
    id: &'a str,
    transport: McpTransport,
    source: OptionSource,
    package: Option<(&'a str, &'a str)>,
    url: Option<&'a str>,
    parameters: &'a [PlanParameter],
    server: &'a Value,
}

impl<'a> Shape<'a> {
    fn of_recorded(option: &'a Analyzed, server: &'a Value) -> Self {
        Self {
            id: &option.id,
            transport: option.transport,
            source: option.source,
            package: option
                .package
                .as_ref()
                .map(|package| (package.registry_type.as_str(), package.identifier.as_str())),
            url: option.url.as_deref(),
            parameters: &option.parameters,
            server,
        }
    }

    fn of_plan(option: &'a PlanOption, server: &'a Value) -> Self {
        Self {
            id: &option.id,
            transport: option.transport,
            source: option.source,
            package: option
                .package
                .as_ref()
                .map(|package| (package.registry_type.as_str(), package.identifier.as_str())),
            url: option.url.as_deref(),
            parameters: &option.parameters,
            server,
        }
    }

    /// The same option in another revision: the same kind, transport and
    /// package.
    fn same_option(&self, other: &Shape<'_>) -> bool {
        self.id == other.id
            && self.transport == other.transport
            && self.source == other.source
            && self.package == other.package
    }

    fn parameter(&self, key: &str) -> Option<&'a PlanParameter> {
        self.parameters
            .iter()
            .find(|parameter| parameter.key == key)
    }
}

/// What one entry gave, by the recorded revision's parameter keys.
#[derive(Debug, Default, PartialEq, Eq)]
struct Found {
    values: BTreeMap<String, String>,
    lost: BTreeSet<String>,
}

/// Read `sources` installed with `option` back into its parameters'
/// `current`, and set its `recovery`. Nothing when none was.
pub(super) fn recover_into(option: &mut PlanOption, server: &Value, sources: &[Source<'_>]) {
    let mut from = Vec::new();
    let mut unmatched = Vec::new();
    let mut by_key: BTreeMap<String, Vec<(McpAppType, String)>> = BTreeMap::new();
    let mut lost: BTreeMap<String, BTreeSet<McpAppType>> = BTreeMap::new();
    {
        let target = Shape::of_plan(option, server);
        for source in sources.iter().filter(|source| source.option == option.id) {
            let recorded = source.schema.and_then(|schema| {
                schema
                    .options
                    .iter()
                    .find(|recorded| recorded.id == option.id)
                    .map(|recorded| Shape::of_recorded(recorded, &schema.server))
            });
            let found = recorded
                .as_ref()
                .filter(|recorded| recorded.same_option(&target))
                .zip(source.definition)
                .and_then(|(recorded, definition)| {
                    read(recorded, definition).map(|found| (recorded, found))
                });
            let Some((recorded, found)) = found else {
                unmatched.push(source.agent);
                continue;
            };
            from.push(source.agent);
            for (key, value) in found.values {
                match counterpart(recorded, &target, &key) {
                    Some(key) => by_key.entry(key).or_default().push((source.agent, value)),
                    None => {
                        lost.entry(key).or_default().insert(source.agent);
                    }
                }
            }
            for key in found.lost {
                lost.entry(key).or_default().insert(source.agent);
            }
        }
    }
    if from.is_empty() && unmatched.is_empty() {
        return;
    }
    for parameter in &mut option.parameters {
        let Some(found) = by_key.get(&parameter.key) else {
            continue;
        };
        let value = found[0].1.clone();
        parameter.current = Some(RecoveredValue {
            conflicting: found.len() < from.len() || found.iter().any(|(_, other)| *other != value),
            agents: found.iter().map(|(agent, _)| *agent).collect(),
            value,
        });
    }
    option.recovery = Some(OptionRecovery {
        from,
        unmatched,
        lost: lost
            .into_iter()
            .map(|(key, agents)| LostValue {
                key,
                agents: agents.into_iter().collect(),
            })
            .collect(),
    });
}

/// The new revision's parameter that the recorded revision's `key` is: the
/// same env variable, header or URL variable, or the package argument of the
/// same kind and name — each only when it is one, and as secret (or not) as
/// before. `None` when that is not certain.
fn counterpart(recorded: &Shape<'_>, target: &Shape<'_>, key: &str) -> Option<String> {
    let before = recorded.parameter(key)?;
    let key = match key.strip_prefix("package_arguments.") {
        Some(index) => {
            let index: usize = index.parse().ok()?;
            let (old, new) = (package_arguments(recorded), package_arguments(target));
            let identity = |argument: &Argument| Some((argument.named, argument.identity.clone()?));
            let wanted = identity(old.get(index)?)?;
            let same = |arguments: &[Argument]| -> Vec<usize> {
                arguments
                    .iter()
                    .enumerate()
                    .filter(|(_, argument)| identity(argument).as_ref() == Some(&wanted))
                    .map(|(index, _)| index)
                    .collect()
            };
            match (same(&old).as_slice(), same(&new).as_slice()) {
                ([_], [index]) => format!("package_arguments.{index}"),
                _ => return None,
            }
        }
        None => key.to_string(),
    };
    let after = target.parameter(&key)?;
    (after.secret == before.secret && after.location == before.location).then_some(key)
}

/// What `definition` holds for `shape`'s parameters; `None` when it is not
/// an entry of this option at all (another transport, or not the package).
fn read(shape: &Shape<'_>, definition: &McpDefinition) -> Option<Found> {
    let mut found = Found::default();
    let by_name = |prefix: &str, map: &BTreeMap<String, String>, found: &mut Found| {
        for (name, value) in map {
            let key = format!("{prefix}.{name}");
            if shape.parameter(&key).is_some() {
                found.values.insert(key, value.clone());
            } else {
                found.lost.insert(key);
            }
        }
    };
    match definition {
        McpDefinition::Stdio { command, args, env } => {
            if shape.transport != McpTransport::Stdio {
                return None;
            }
            let (registry_type, identifier) = shape.package?;
            let runtime = match registry_type {
                "npm" => "npx",
                "pypi" => "uvx",
                _ => return None,
            };
            if command != runtime {
                return None;
            }
            by_name("env", env, &mut found);
            let operand = args.iter().position(|arg| {
                arg == identifier
                    || arg
                        .strip_prefix(identifier)
                        .is_some_and(|rest| rest.starts_with('@') || rest.starts_with("=="))
            });
            match operand {
                Some(at) => read_arguments(shape, &args[at + 1..], &mut found),
                // Another package, or a version of this one under another
                // name: its arguments cannot be placed.
                None if args.iter().any(|arg| arg != "-y") => {
                    found.lost.insert("args".to_string());
                }
                None => {}
            }
        }
        McpDefinition::Http { url, headers } | McpDefinition::Sse { url, headers } => {
            if !shape.transport.is_remote() {
                return None;
            }
            by_name("headers", headers, &mut found);
            read_variables(shape, url, &mut found);
        }
    }
    Some(found)
}

/// One package argument as the server.json declares it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Argument {
    key: String,
    named: bool,
    /// What it is known by: its name, else its value hint.
    identity: Option<String>,
    /// Its `--flag`, for a named one.
    name: Option<String>,
    /// The converter leaves it out when it has no value: optional, and
    /// without a value or default of its own.
    omittable: bool,
}

fn package_arguments(shape: &Shape<'_>) -> Vec<Argument> {
    let Some((OptionSource::Package, index)) = parse_option_id(shape.id) else {
        return Vec::new();
    };
    let text = |argument: &Value, key: &str| {
        argument
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    shape
        .server
        .get("packages")
        .and_then(Value::as_array)
        .and_then(|packages| packages.get(index))
        .and_then(|package| package.get("packageArguments"))
        .and_then(Value::as_array)
        .map(|arguments| {
            arguments
                .iter()
                .enumerate()
                .map(|(index, argument)| {
                    let key = format!("package_arguments.{index}");
                    let named = argument.get("type").and_then(Value::as_str) == Some("named");
                    let name = text(argument, "name");
                    let omittable = shape
                        .parameter(&key)
                        .is_none_or(|parameter| !parameter.required && parameter.default.is_none());
                    Argument {
                        identity: name.clone().or_else(|| text(argument, "valueHint")),
                        name: name.filter(|_| named),
                        key,
                        named,
                        omittable,
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Every way `tokens` can be what the converter wrote for `arguments`: per
/// argument, its value or `None` (left out). At most `limit` of them.
fn arrangements(
    arguments: &[Argument],
    tokens: &[String],
    limit: usize,
) -> Vec<Vec<Option<String>>> {
    fn walk(
        arguments: &[Argument],
        tokens: &[String],
        at: usize,
        current: &mut Vec<Option<String>>,
        out: &mut Vec<Vec<Option<String>>>,
        limit: usize,
    ) {
        if out.len() >= limit {
            return;
        }
        let Some(argument) = arguments.get(current.len()) else {
            if at == tokens.len() {
                out.push(current.clone());
            }
            return;
        };
        if argument.omittable {
            current.push(None);
            walk(arguments, tokens, at, current, out, limit);
            current.pop();
        }
        if argument.named {
            // `--flag value`; a named argument without a name is never written.
            if let (Some(name), Some(value)) = (&argument.name, tokens.get(at + 1)) {
                if tokens[at] == *name {
                    current.push(Some(value.clone()));
                    walk(arguments, tokens, at + 2, current, out, limit);
                    current.pop();
                }
            }
        } else if let Some(token) = tokens.get(at) {
            current.push(Some(token.clone()));
            walk(arguments, tokens, at + 1, current, out, limit);
            current.pop();
        }
    }
    let mut out = Vec::new();
    walk(arguments, tokens, 0, &mut Vec::new(), &mut out, limit);
    out
}

fn read_arguments(shape: &Shape<'_>, tokens: &[String], found: &mut Found) {
    let arguments = package_arguments(shape);
    let all_lost = |found: &mut Found| {
        if arguments.is_empty() {
            found.lost.insert("args".to_string());
        } else {
            found
                .lost
                .extend(arguments.iter().map(|argument| argument.key.clone()));
        }
    };
    if tokens.is_empty() && arguments.iter().all(|argument| argument.omittable) {
        return;
    }
    if arguments.len() > MAX_ARGUMENTS {
        all_lost(found);
        return;
    }
    // One past the cap, to tell "all of them" from "the first so many".
    let ways = arrangements(&arguments, tokens, MAX_ARRANGEMENTS + 1);
    if ways.is_empty() || ways.len() > MAX_ARRANGEMENTS {
        // No way the arguments could have written these tokens — or more ways
        // than are compared, when agreeing among some proves nothing.
        all_lost(found);
        return;
    }
    for (index, argument) in arguments.iter().enumerate() {
        let first = &ways[0][index];
        if ways.iter().all(|way| way[index] == *first) {
            if let Some(value) = first {
                found.values.insert(argument.key.clone(), value.clone());
            }
        } else {
            found.lost.insert(argument.key.clone());
        }
    }
}

/// `{name}` and `{{name}}` placeholders in `template`, in order, with the
/// text before each (and the text after the last).
fn placeholders(template: &str) -> Vec<(String, Option<String>)> {
    let pattern = regex::Regex::new(r"\{\{([^{}]+)\}\}|\{([^{}]+)\}").expect("a valid pattern");
    let mut parts = Vec::new();
    let mut last = 0;
    for captures in pattern.captures_iter(template) {
        let whole = captures.get(0).expect("the whole match");
        let name = captures
            .get(1)
            .or_else(|| captures.get(2))
            .map(|name| name.as_str().trim().to_string());
        parts.push((template[last..whole.start()].to_string(), name));
        last = whole.end();
    }
    parts.push((template[last..].to_string(), None));
    parts
}

/// The address as the template writes it — each placeholder one encoded
/// value (which holds no `/ ? # &`), then whatever query the converter
/// appended — with each value taken as long (`greedy`) or as short as it
/// can be.
fn template_pattern(parts: &[(String, Option<String>)], greedy: bool) -> Option<regex::Regex> {
    let mut pattern = String::from("^");
    for (literal, name) in parts {
        pattern.push_str(&regex::escape(literal));
        if name.is_some() {
            pattern.push_str(if greedy { "([^/?#&]*)" } else { "([^/?#&]*?)" });
        }
    }
    pattern.push_str("(?:[?&#].*)?$");
    regex::Regex::new(&pattern).ok()
}

/// The values the template's placeholders hold in `url`, by name — only
/// when there is exactly one way to read them. With the longest and the
/// shortest reading of each value in turn agreeing on every span, every
/// reading agrees: each value's span is then the same in all of them.
fn template_values(
    parts: &[(String, Option<String>)],
    url: &str,
) -> Option<BTreeMap<String, String>> {
    let longest = template_pattern(parts, true)?.captures(url)?;
    let shortest = template_pattern(parts, false)?.captures(url)?;
    let names: Vec<&str> = parts
        .iter()
        .filter_map(|(_, name)| name.as_deref())
        .collect();
    let mut values: BTreeMap<String, String> = BTreeMap::new();
    for (group, name) in names.iter().enumerate() {
        let (a, b) = (longest.get(group + 1)?, shortest.get(group + 1)?);
        if a.range() != b.range() {
            return None;
        }
        let value = urlencoding::decode(a.as_str()).ok()?.into_owned();
        // The same name twice must hold the same value.
        if values
            .insert((*name).to_string(), value.clone())
            .is_some_and(|before| before != value)
        {
            return None;
        }
    }
    Some(values)
}

fn read_variables(shape: &Shape<'_>, url: &str, found: &mut Found) {
    let variables: Vec<&str> = shape
        .parameters
        .iter()
        .filter_map(|parameter| parameter.key.strip_prefix("variables."))
        .collect();
    if variables.is_empty() {
        return;
    }
    let parts = shape.url.map(placeholders).unwrap_or_default();
    let templated: BTreeSet<&str> = parts
        .iter()
        .filter_map(|(_, name)| name.as_deref())
        .collect();
    if !templated.is_empty() {
        match template_values(&parts, url) {
            Some(values) => {
                for (name, value) in values {
                    if variables.contains(&name.as_str()) {
                        found.values.insert(format!("variables.{name}"), value);
                    }
                }
            }
            // No match, or more than one way to split it: nothing of it is
            // taken.
            None => {
                for name in templated.iter().filter(|name| variables.contains(name)) {
                    found.lost.insert(format!("variables.{name}"));
                }
            }
        }
    }
    // A variable the template has no place for went into the query — once.
    let query: Vec<(String, String)> = url::Url::parse(url)
        .map(|parsed| parsed.query_pairs().into_owned().collect())
        .unwrap_or_default();
    for name in variables.iter().filter(|name| !templated.contains(**name)) {
        let mut given = query.iter().filter(|(key, _)| key == name);
        match (given.next(), given.next()) {
            (Some((_, value)), None) => {
                found
                    .values
                    .insert(format!("variables.{name}"), value.clone());
            }
            (Some(_), Some(_)) => {
                found.lost.insert(format!("variables.{name}"));
            }
            (None, _) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::mcp::model::PlanPackage;
    use serde_json::json;

    /// The plan's option `id` of `server`, as the plan builds it.
    fn plan_option(server: &Value, id: &str) -> PlanOption {
        let analyzed = analyze(server, &[])
            .unwrap()
            .into_iter()
            .find(|option| option.id == id)
            .unwrap_or_else(|| panic!("no option {id}"));
        PlanOption {
            id: analyzed.id.clone(),
            transport: analyzed.transport,
            source: analyzed.source,
            package: analyzed.package.as_ref().map(|package| PlanPackage {
                registry_type: package.registry_type.clone(),
                identifier: package.identifier.clone(),
                version: None,
                verified: None,
                has_install_script: false,
                runtime: package.runtime.clone(),
            }),
            definition: analyzed.definition.clone(),
            url: analyzed.url.clone(),
            parameters: analyzed.parameters.clone(),
            blocking: vec![],
            warnings: vec![],
            selectable: true,
            default_targets: vec![],
            default_replace: vec![],
            recovery: None,
        }
    }

    fn stdio(args: &[&str], env: &[(&str, &str)]) -> McpDefinition {
        McpDefinition::Stdio {
            command: "npx".into(),
            args: args.iter().map(|arg| arg.to_string()).collect(),
            env: env
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }
    }

    fn http(url: &str, headers: &[(&str, &str)]) -> McpDefinition {
        McpDefinition::Http {
            url: url.into(),
            headers: headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }
    }

    fn current(option: &PlanOption, key: &str) -> Option<RecoveredValue> {
        option
            .parameters
            .iter()
            .find(|parameter| parameter.key == key)
            .and_then(|parameter| parameter.current.clone())
    }

    fn lost(option: &PlanOption) -> Vec<(String, Vec<McpAppType>)> {
        option
            .recovery
            .as_ref()
            .map(|recovery| {
                recovery
                    .lost
                    .iter()
                    .map(|lost| (lost.key.clone(), lost.agents.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Recover `entries` (agent, definition) installed from `recorded`'s
    /// option `id` into `target`'s option `id`.
    fn recover(
        recorded: &Value,
        target: &Value,
        id: &str,
        entries: &[(McpAppType, McpDefinition)],
    ) -> PlanOption {
        let schema = Schema::new(recorded.clone());
        let sources: Vec<Source<'_>> = entries
            .iter()
            .map(|(agent, definition)| Source {
                agent: *agent,
                option: id,
                schema: Some(&schema),
                definition: Some(definition),
            })
            .collect();
        let mut option = plan_option(target, id);
        recover_into(&mut option, target, &sources);
        option
    }

    fn npm(arguments: Value, env: Value) -> Value {
        json!({ "name": "x", "packages": [{
            "registryType": "npm", "identifier": "@acme/notes", "transport": { "type": "stdio" },
            "packageArguments": arguments, "environmentVariables": env
        }]})
    }

    fn remote(url: &str, variables: Value) -> Value {
        json!({ "name": "x", "remotes": [{ "type": "streamable-http", "url": url, "variables": variables }] })
    }

    const STDIO: &str = "official:package:0:stdio";
    const HTTP: &str = "official:remote:0:http";

    #[test]
    fn env_and_arguments_are_read_back_from_a_stdio_entry() {
        let server = npm(
            json!([
                { "type": "named", "name": "--root" },
                { "type": "positional", "valueHint": "mode", "default": "fast" },
                { "type": "named", "name": "--verbose" }
            ]),
            json!([{ "name": "NOTES_TOKEN", "isSecret": true }, { "name": "NOTES_DIR" }]),
        );
        let claude = stdio(
            &["-y", "@acme/notes@1.2.3", "--root", "/notes", "slow"],
            &[("NOTES_TOKEN", "t0ken"), ("EXTRA", "mine")],
        );
        let codex = stdio(
            &["-y", "@acme/notes@1.2.3", "fast"],
            &[("NOTES_TOKEN", "other")],
        );
        let option = recover(
            &server,
            &server,
            STDIO,
            &[(McpAppType::ClaudeCode, claude), (McpAppType::Codex, codex)],
        );
        let token = current(&option, "env.NOTES_TOKEN").unwrap();
        assert_eq!(token.value, "t0ken");
        assert_eq!(token.agents, [McpAppType::ClaudeCode, McpAppType::Codex]);
        assert!(token.conflicting);
        let root = current(&option, "package_arguments.0").unwrap();
        assert_eq!(root.value, "/notes");
        assert!(root.conflicting, "Codex has none");
        let mode = current(&option, "package_arguments.1").unwrap();
        assert_eq!(mode.value, "slow");
        assert!(mode.conflicting, "Codex has the default");
        assert!(current(&option, "env.NOTES_DIR").is_none());
        assert!(current(&option, "package_arguments.2").is_none());
        assert_eq!(
            lost(&option),
            [("env.EXTRA".to_string(), vec![McpAppType::ClaudeCode])]
        );
    }

    /// Review finding: an optional positional left out, and the next one at
    /// its default, wrote `["safe"]` — which is the second, not the first.
    /// And when both could be left out, it could be either: lost.
    #[test]
    fn an_omitted_argument_is_accounted_for_and_an_unclear_one_is_lost() {
        let entry = stdio(&["-y", "@acme/notes@1.2.3", "safe"], &[]);
        let defaulted = npm(
            json!([
                { "type": "positional", "valueHint": "target" },
                { "type": "positional", "valueHint": "mode", "default": "safe" }
            ]),
            json!([]),
        );
        let option = recover(
            &defaulted,
            &defaulted,
            STDIO,
            &[(McpAppType::ClaudeCode, entry.clone())],
        );
        assert!(
            current(&option, "package_arguments.0").is_none(),
            "left out"
        );
        assert_eq!(
            current(&option, "package_arguments.1").unwrap().value,
            "safe"
        );
        assert!(lost(&option).is_empty());

        let both_optional = npm(
            json!([
                { "type": "positional", "valueHint": "target" },
                { "type": "positional", "valueHint": "mode" }
            ]),
            json!([]),
        );
        let option = recover(
            &both_optional,
            &both_optional,
            STDIO,
            &[(McpAppType::ClaudeCode, entry)],
        );
        assert!(current(&option, "package_arguments.0").is_none());
        assert!(current(&option, "package_arguments.1").is_none());
        assert_eq!(
            lost(&option),
            [
                (
                    "package_arguments.0".to_string(),
                    vec![McpAppType::ClaudeCode]
                ),
                (
                    "package_arguments.1".to_string(),
                    vec![McpAppType::ClaudeCode]
                ),
            ]
        );
    }

    /// Review finding: ten optional positionals (only the second required),
    /// five values given → 126 arrangements, of which the first 70 leave the
    /// first argument out. Agreeing within a capped set is not certainty:
    /// past the cap, every argument is lost — and none is read as absent.
    #[test]
    fn too_many_arrangements_to_compare_gives_no_values() {
        let arguments: Vec<Value> = (0..10)
            .map(|index| {
                json!({ "type": "positional", "valueHint": format!("arg{index}"),
                        "isRequired": index == 1 })
            })
            .collect();
        let server = npm(Value::Array(arguments), json!([]));
        let entry = stdio(
            &[
                "-y",
                "@acme/notes@1.2.3",
                "first",
                "second",
                "third",
                "fourth",
                "fifth",
            ],
            &[],
        );
        let shape_server = server.clone();
        let schema = Schema::new(server.clone());
        let recorded = schema
            .options
            .iter()
            .find(|option| option.id == STDIO)
            .unwrap();
        let shape = Shape::of_recorded(recorded, &shape_server);
        let tokens: Vec<String> = ["first", "second", "third", "fourth", "fifth"]
            .iter()
            .map(|token| token.to_string())
            .collect();
        let all = arrangements(&package_arguments(&shape), &tokens, usize::MAX);
        assert_eq!(all.len(), 126);
        assert!(all[..70].iter().all(|way| way[0].is_none()));

        let option = recover(&server, &server, STDIO, &[(McpAppType::ClaudeCode, entry)]);
        assert!(
            option
                .parameters
                .iter()
                .all(|parameter| parameter.current.is_none()),
            "{:?}",
            option
                .parameters
                .iter()
                .map(|parameter| &parameter.current)
                .collect::<Vec<_>>()
        );
        let keys: Vec<String> = lost(&option).into_iter().map(|(key, _)| key).collect();
        let mut expected: Vec<String> = (0..10)
            .map(|index| format!("package_arguments.{index}"))
            .collect();
        expected.sort();
        assert_eq!(keys, expected);
    }

    #[test]
    fn arguments_that_cannot_be_placed_are_lost() {
        let server = npm(json!([{ "type": "named", "name": "--root" }]), json!([]));
        let edited = stdio(&["-y", "@acme/notes@1.2.3", "--port", "9000"], &[]);
        let renamed = stdio(&["-y", "@acme/old-notes@1.0.0", "--root", "/x"], &[]);
        let option = recover(
            &server,
            &server,
            STDIO,
            &[
                (McpAppType::ClaudeCode, edited),
                (McpAppType::Gemini, renamed),
            ],
        );
        assert_eq!(
            lost(&option),
            [
                ("args".to_string(), vec![McpAppType::Gemini]),
                (
                    "package_arguments.0".to_string(),
                    vec![McpAppType::ClaudeCode]
                ),
            ]
        );
        assert!(current(&option, "package_arguments.0").is_none());
    }

    #[test]
    fn url_variables_are_read_by_the_template_and_from_the_query() {
        let server = remote(
            "https://{tenant}.example.com/{{token}}/mcp",
            json!({ "tenant": {}, "token": { "isSecret": true }, "region": {} }),
        );
        let entry = http(
            "https://acme.example.com/s%2F3cret/mcp?region=eu%20west",
            &[("X-Extra", "1")],
        );
        let moved = http("https://elsewhere.example.org/mcp", &[]);
        let option = recover(
            &server,
            &server,
            HTTP,
            &[(McpAppType::ClaudeCode, entry), (McpAppType::Gemini, moved)],
        );
        assert_eq!(current(&option, "variables.tenant").unwrap().value, "acme");
        assert_eq!(
            current(&option, "variables.token").unwrap().value,
            "s/3cret"
        );
        assert_eq!(
            current(&option, "variables.region").unwrap().value,
            "eu west"
        );
        assert_eq!(
            lost(&option),
            [
                ("headers.X-Extra".to_string(), vec![McpAppType::ClaudeCode]),
                ("variables.tenant".to_string(), vec![McpAppType::Gemini]),
                ("variables.token".to_string(), vec![McpAppType::Gemini]),
            ]
        );
    }

    /// Review finding: `/{tenant}-{token}/mcp` with tenant `acme` and the
    /// secret token `demo-secret` reads as tenant `acme-demo`, token
    /// `secret` — part of a secret shown as a plain value. When an address
    /// can be split more than one way, nothing of it is taken.
    #[test]
    fn an_address_that_splits_more_than_one_way_gives_no_values() {
        let variables = json!({ "tenant": {}, "token": { "isSecret": true } });
        for (template, url) in [
            // a separator a value may contain
            (
                "https://mcp.example.com/{tenant}-{token}/mcp",
                "https://mcp.example.com/acme-demo-secret/mcp",
            ),
            (
                "https://mcp.example.com/{tenant}.{token}/mcp",
                "https://mcp.example.com/acme.demo.secret/mcp",
            ),
            // side by side
            (
                "https://mcp.example.com/{tenant}{token}/mcp",
                "https://mcp.example.com/acmedemosecret/mcp",
            ),
            // an encoded separator
            (
                "https://mcp.example.com/{tenant}%2F{token}/mcp",
                "https://mcp.example.com/a%2Fb%2Fc/mcp",
            ),
        ] {
            let server = remote(template, variables.clone());
            let option = recover(
                &server,
                &server,
                HTTP,
                &[(McpAppType::ClaudeCode, http(url, &[]))],
            );
            assert!(current(&option, "variables.tenant").is_none(), "{template}");
            assert!(current(&option, "variables.token").is_none(), "{template}");
            assert_eq!(
                lost(&option),
                [
                    ("variables.tenant".to_string(), vec![McpAppType::ClaudeCode]),
                    ("variables.token".to_string(), vec![McpAppType::ClaudeCode]),
                ],
                "{template}"
            );
        }
        // the same separator, but only one way to read it: taken
        let server = remote("https://mcp.example.com/{tenant}-{token}/mcp", variables);
        let option = recover(
            &server,
            &server,
            HTTP,
            &[(
                McpAppType::ClaudeCode,
                http("https://mcp.example.com/acme-s3cret/mcp", &[]),
            )],
        );
        assert_eq!(current(&option, "variables.tenant").unwrap().value, "acme");
        assert_eq!(current(&option, "variables.token").unwrap().value, "s3cret");
    }

    /// Review finding: revision 1 wrote `/{token}/{tenant}/mcp`, revision 2
    /// reads `/{tenant}/{token}/mcp`. The entry is read with revision 1's
    /// template, and carried to revision 2 by name.
    #[test]
    fn an_entry_is_read_with_the_revision_it_was_installed_from() {
        let variables = json!({ "tenant": {}, "token": { "isSecret": true } });
        let before = remote(
            "https://mcp.example.com/{token}/{tenant}/mcp",
            variables.clone(),
        );
        let after = remote("https://mcp.example.com/{tenant}/{token}/mcp", variables);
        let entry = http("https://mcp.example.com/demo-secret/acme/mcp", &[]);
        let option = recover(&before, &after, HTTP, &[(McpAppType::ClaudeCode, entry)]);
        assert_eq!(current(&option, "variables.tenant").unwrap().value, "acme");
        assert_eq!(
            current(&option, "variables.token").unwrap().value,
            "demo-secret"
        );
        assert!(lost(&option).is_empty());
    }

    /// Carried to the new revision only where that is certain: not into a
    /// parameter that became secret (or stopped being one), not into one
    /// that is gone, and an argument only to the one of the same name.
    #[test]
    fn only_what_maps_with_certainty_is_carried_to_the_new_revision() {
        let before = npm(
            json!([
                { "type": "named", "name": "--root" },
                { "type": "positional", "valueHint": "mode", "isRequired": true }
            ]),
            json!([{ "name": "NOTES_DIR" }, { "name": "NOTES_KEY", "isSecret": true }, { "name": "OLD" }]),
        );
        let after = npm(
            json!([
                { "type": "positional", "valueHint": "mode", "isRequired": true },
                { "type": "named", "name": "--root" }
            ]),
            // NOTES_DIR is a secret now; OLD is gone
            json!([{ "name": "NOTES_DIR", "isSecret": true }, { "name": "NOTES_KEY", "isSecret": true }]),
        );
        let entry = stdio(
            &["-y", "@acme/notes@1.0.0", "--root", "/notes", "fast"],
            &[("NOTES_DIR", "/d"), ("NOTES_KEY", "k3y"), ("OLD", "x")],
        );
        let option = recover(&before, &after, STDIO, &[(McpAppType::ClaudeCode, entry)]);
        assert_eq!(
            current(&option, "package_arguments.1").unwrap().value,
            "/notes",
            "--root moved"
        );
        assert_eq!(
            current(&option, "package_arguments.0").unwrap().value,
            "fast",
            "mode moved"
        );
        assert_eq!(current(&option, "env.NOTES_KEY").unwrap().value, "k3y");
        assert!(
            current(&option, "env.NOTES_DIR").is_none(),
            "its secrecy changed"
        );
        assert_eq!(
            lost(&option),
            [
                ("env.NOTES_DIR".to_string(), vec![McpAppType::ClaudeCode]),
                ("env.OLD".to_string(), vec![McpAppType::ClaudeCode]),
            ]
        );
    }

    #[test]
    fn an_entry_whose_revision_or_option_cannot_be_read_carries_nothing() {
        let server = npm(json!([]), json!([{ "name": "NOTES_DIR" }]));
        let entry = stdio(&["-y", "@acme/notes@1.0.0"], &[("NOTES_DIR", "/d")]);
        let mut other_package = npm(json!([]), json!([{ "name": "NOTES_DIR" }]));
        other_package["packages"][0]["identifier"] = json!("@acme/other");
        let schema = Schema::new(other_package);
        let mut option = plan_option(&server, STDIO);
        recover_into(
            &mut option,
            &server,
            &[
                // its revision's server.json could not be read
                Source {
                    agent: McpAppType::ClaudeCode,
                    option: STDIO,
                    schema: None,
                    definition: Some(&entry),
                },
                // the option is another package in that revision
                Source {
                    agent: McpAppType::Codex,
                    option: STDIO,
                    schema: Some(&schema),
                    definition: Some(&entry),
                },
                // installed with another option: not this one's
                Source {
                    agent: McpAppType::Gemini,
                    option: HTTP,
                    schema: None,
                    definition: Some(&entry),
                },
            ],
        );
        let recovery = option.recovery.as_ref().unwrap();
        assert!(recovery.from.is_empty());
        assert_eq!(
            recovery.unmatched,
            [McpAppType::ClaudeCode, McpAppType::Codex]
        );
        assert!(current(&option, "env.NOTES_DIR").is_none());
    }
}
