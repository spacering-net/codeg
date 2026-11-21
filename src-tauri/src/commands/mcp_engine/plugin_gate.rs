//! `enabledPlugins` in Claude Code's and CodeBuddy's `settings.json`.
//!
//! Both CLIs activate a user-scope server through `<name>@local: true` in
//! that map, so codeg has always written the key alongside the server and
//! taken it away with it. The engine keeps doing so — through the CST, so the
//! rest of the settings file (which the Agents page also edits) is not
//! reformatted — and treats the file as part of the same write: it is copied
//! before, put back if a later write fails, and never written when nothing in
//! it changes.
//!
//! A key that is there twice is refused, as it is in the servers' own file
//! (`json_doc`): the CLI reads the last `enabledPlugins`, an edit would land
//! on the first.

use jsonc_parser::cst::{CstObject, CstRootNode};
use serde_json::Value;

use crate::acp::opencode_config;

use super::json_doc::occurrences;
use super::model::{codes, McpIssue};
use super::store::{split_bom, with_bom};

const MAP: &str = "enabledPlugins";

/// The marketplace suffix of a user-managed entry: `figma@local` activates a
/// user-scope server, `figma@user` does not.
fn plugin_key(name: &str) -> String {
    format!("{name}@local")
}

fn duplicate(key: String) -> McpIssue {
    McpIssue::new(codes::DUPLICATE_KEY).detail(key)
}

/// The settings document `source` open for editing, once it is one codeg can
/// edit `enabledPlugins` in: an object at the root, the map there at most
/// once, and an object when it is there.
fn open(source: &str) -> Result<(CstRootNode, CstObject), McpIssue> {
    match opencode_config::parse(source) {
        Ok(Value::Object(_)) => {}
        Ok(_) => return Err(McpIssue::new(codes::ROOT_NOT_OBJECT)),
        Err(e) => return Err(McpIssue::new(codes::INVALID_JSON).detail(e)),
    }
    let root = CstRootNode::parse(source, &opencode_config::parse_options())
        .map_err(|e| McpIssue::new(codes::INVALID_JSON).detail(e.to_string()))?;
    let object = root
        .object_value()
        .ok_or_else(|| McpIssue::new(codes::ROOT_NOT_OBJECT))?;
    match occurrences(&object, MAP) {
        0 => {}
        1 if object.object_value(MAP).is_some() => {}
        1 => return Err(McpIssue::new(codes::CONTAINER_INVALID).detail(MAP)),
        _ => return Err(duplicate(MAP.to_string())),
    }
    Ok((root, object))
}

/// Why codeg cannot edit `enabledPlugins` in the settings file `text`,
/// whatever the server — for the inventory. `None` when it can; a file that
/// is empty or not there can be made.
pub(crate) fn inspect(text: &str) -> Option<McpIssue> {
    let (_, body) = split_bom(text);
    let source = if body.trim().is_empty() { "{}" } else { body };
    open(source).err()
}

/// `text` with each `(server name, present)` applied to `enabledPlugins`, or
/// `None` when that changes nothing. Text that is empty is `{}`. Refused,
/// with the reason: text that does not parse, an `enabledPlugins` that is
/// not an object, and a key this would have to pick one of two of — the map
/// itself, or the `<name>@local` of a server in `changes`.
pub(crate) fn apply(text: &str, changes: &[(String, bool)]) -> Result<Option<String>, McpIssue> {
    if changes.is_empty() {
        return Ok(None);
    }
    let (bom, body) = split_bom(text);
    let was_empty = body.trim().is_empty();
    let source = if was_empty { "{}" } else { body };
    let (root, object) = open(source)?;
    let mut dirty = false;
    for (name, present) in changes {
        let key = plugin_key(name);
        if let Some(plugins) = object.object_value(MAP) {
            if occurrences(&plugins, &key) > 1 {
                return Err(duplicate(format!("{MAP}.{key}")));
            }
        }
        if *present {
            let plugins = object
                .object_value_or_create(MAP)
                .ok_or_else(|| McpIssue::new(codes::CONTAINER_INVALID).detail(MAP))?;
            let already = plugins
                .get(&key)
                .and_then(|prop| prop.value())
                .is_some_and(|node| node.to_string().trim() == "true");
            if !already {
                opencode_config::set_property(&plugins, &key, &Value::Bool(true));
                dirty = true;
            }
        } else if let Some(plugins) = object.object_value(MAP) {
            dirty |= opencode_config::remove_property(&plugins, &key);
        }
    }
    if !dirty {
        return Ok(None);
    }
    let mut out = root.to_string();
    if was_empty && !out.ends_with('\n') {
        out.push('\n');
    }
    Ok(Some(with_bom(bom, out)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn change(name: &str, present: bool) -> (String, bool) {
        (name.to_string(), present)
    }

    #[test]
    fn a_server_is_activated_and_deactivated_without_touching_the_rest() {
        let text = "{\n  // model\n  \"model\": \"opus\",\n  \"enabledPlugins\": {\n    \"keep@market\": true,\n    \"old@local\": true\n  }\n}\n";
        let out = apply(text, &[change("new", true), change("old", false)])
            .unwrap()
            .expect("changes");
        assert!(out.contains("// model"), "{out}");
        assert_eq!(
            opencode_config::parse(&out).unwrap(),
            json!({"model": "opus", "enabledPlugins": {"keep@market": true, "new@local": true}})
        );
    }

    #[test]
    fn nothing_to_change_is_nothing_to_write() {
        let text = r#"{"enabledPlugins": {"a@local": true}}"#;
        assert_eq!(apply(text, &[change("a", true)]).unwrap(), None);
        assert_eq!(apply(text, &[change("absent", false)]).unwrap(), None);
        assert_eq!(apply("", &[change("absent", false)]).unwrap(), None);
        assert_eq!(apply(text, &[]).unwrap(), None);
    }

    #[test]
    fn a_missing_file_or_map_is_made() {
        let out = apply("", &[change("a", true)]).unwrap().expect("changes");
        assert_eq!(
            opencode_config::parse(&out).unwrap(),
            json!({"enabledPlugins": {"a@local": true}})
        );
        assert!(out.ends_with('\n'));
        // A key that is there with another value is set.
        let out = apply(
            r#"{"enabledPlugins": {"a@local": false}}"#,
            &[change("a", true)],
        )
        .unwrap()
        .expect("changes");
        assert_eq!(
            opencode_config::parse(&out).unwrap(),
            json!({"enabledPlugins": {"a@local": true}})
        );
    }

    #[test]
    fn a_settings_file_codeg_cannot_edit_is_refused() {
        assert!(apply("{ nope", &[change("a", true)]).is_err());
        assert!(apply("[1]", &[change("a", true)]).is_err());
        assert!(apply(r#"{"enabledPlugins": 3}"#, &[change("a", true)]).is_err());
    }

    /// The CLI reads the last of two keys, an edit would reach the first.
    #[test]
    fn a_key_that_is_there_twice_is_refused() {
        let code_and_detail = |problem: &McpIssue| (problem.code.clone(), problem.detail.clone());
        let duplicate = |key: &str| (codes::DUPLICATE_KEY.to_string(), Some(key.to_string()));

        // The map itself.
        let twice = r#"{"enabledPlugins": {"a@local": true}, "enabledPlugins": {}}"#;
        let problem = apply(twice, &[change("b", true)]).unwrap_err();
        assert_eq!(code_and_detail(&problem), duplicate("enabledPlugins"));
        assert_eq!(
            inspect(twice).as_ref().map(code_and_detail),
            Some(duplicate("enabledPlugins"))
        );

        // The key of a server the change is about — and only that one.
        let text = r#"{"enabledPlugins": {"x@local": true, "x@local": false, "y@local": true}}"#;
        for present in [true, false] {
            let problem = apply(text, &[change("x", present)]).unwrap_err();
            assert_eq!(
                code_and_detail(&problem),
                duplicate("enabledPlugins.x@local")
            );
        }
        assert!(apply(text, &[change("y", false)]).unwrap().is_some());
        assert_eq!(inspect(text), None, "the file as a whole can be edited");

        // What else the inventory is told about a settings file.
        assert_eq!(inspect(""), None);
        assert_eq!(inspect(r#"{"model": "opus"}"#), None);
        let code = |text: &str| inspect(text).map(|problem| problem.code);
        assert_eq!(code("{ nope").as_deref(), Some(codes::INVALID_JSON));
        assert_eq!(code("[1]").as_deref(), Some(codes::ROOT_NOT_OBJECT));
        assert_eq!(
            code(r#"{"enabledPlugins": 3}"#).as_deref(),
            Some(codes::CONTAINER_INVALID)
        );
    }
}
