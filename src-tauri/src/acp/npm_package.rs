//! npm packages on disk, found the way node finds them: which package an npm
//! command belongs to, what a package `require`s from its own folder, and
//! what its package.json says.
//!
//! Shared by everything that needs to know what an ACP wrapper carries
//! (`acp::codex_runtime` for the codex a Codex launch runs, the Harness
//! plugin host adapters for the hosts the wrappers bundle).

use std::path::{Path, PathBuf};

use serde_json::Value;

/// How far up from the command's real path its package.json may sit
/// (`dist/index.js` is one level below it today).
const SEARCH_DEPTH: usize = 6;
/// A package.json larger than this is not read.
const MANIFEST_BYTES: u64 = 1024 * 1024;

/// The folder of the package `name` that `command` (an npm bin) belongs to.
///
/// npm's Unix bin is a link into the package (`…/<pkg>/dist/index.js`), so
/// walking up from its real path finds it. Windows' bin is a `.cmd` shim
/// beside the prefix's `node_modules`, which is where the package sits.
pub(crate) fn package_dir_for_command(command: &Path, name: &str) -> Option<PathBuf> {
    let real = std::fs::canonicalize(command).ok();
    let mut dir = real.as_deref().unwrap_or(command).parent();
    for _ in 0..SEARCH_DEPTH {
        let Some(current) = dir else { break };
        if is_package(current, name) {
            return Some(current.to_path_buf());
        }
        dir = current.parent();
    }
    let beside = command.parent()?.join("node_modules").join(name_path(name));
    is_package(&beside, name).then_some(beside)
}

/// The folders node searches for a bare specifier required from `start`,
/// nearest first: `start/node_modules`, then each ancestor's, skipping
/// ancestors that are themselves a `node_modules` (node's
/// `NODE_MODULES_PATHS`). A pnpm store's sibling layout resolves through the
/// same walk.
pub(crate) fn lookup_paths(start: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut current = Some(start);
    while let Some(dir) = current {
        if dir.file_name().is_some_and(|base| base != "node_modules") {
            out.push(dir.join("node_modules"));
        }
        current = dir.parent();
    }
    out
}

/// The package `name` as `require` from inside `from` finds it.
pub(crate) fn resolve_from(from: &Path, name: &str) -> Option<PathBuf> {
    lookup_paths(from)
        .into_iter()
        .map(|modules| modules.join(name_path(name)))
        .find(|dir| is_package(dir, name))
}

/// Whether `dir` holds the package `name`.
pub(crate) fn is_package(dir: &Path, name: &str) -> bool {
    field(dir, "name").as_deref() == Some(name)
}

/// The version of the package `name` in `dir`, when `dir` is that package
/// and says one.
pub(crate) fn version(dir: &Path, name: &str) -> Option<String> {
    if !is_package(dir, name) {
        return None;
    }
    field(dir, "version").filter(|version| !version.trim().is_empty())
}

/// A string field of `dir/package.json`.
pub(crate) fn field(dir: &Path, key: &str) -> Option<String> {
    let path = dir.join("package.json");
    if std::fs::metadata(&path).ok()?.len() > MANIFEST_BYTES {
        return None;
    }
    let value: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    value.get(key)?.as_str().map(str::to_string)
}

/// `@scope/name` as a relative path.
fn name_path(name: &str) -> String {
    name.replace('/', std::path::MAIN_SEPARATOR_STR)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_paths_skip_node_modules_ancestors() {
        let paths = lookup_paths(Path::new("/r/.pnpm/x@1/node_modules/@scope/codex-acp"));
        assert_eq!(
            paths[..3],
            [
                PathBuf::from("/r/.pnpm/x@1/node_modules/@scope/codex-acp/node_modules"),
                PathBuf::from("/r/.pnpm/x@1/node_modules/@scope/node_modules"),
                // `/r/.pnpm/x@1/node_modules` itself, not `…/node_modules/node_modules`.
                PathBuf::from("/r/.pnpm/x@1/node_modules"),
            ]
        );
    }

    #[test]
    fn a_package_s_version_and_what_it_requires() {
        let dir = tempfile::tempdir().unwrap();
        let package = dir.path().join("node_modules/@scope/wrapper");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"@scope/wrapper","version":"2.7.0"}"#,
        )
        .unwrap();
        let nested = dir.path().join("node_modules/@openai/codex");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(
            nested.join("package.json"),
            r#"{"name":"@openai/codex","version":" "}"#,
        )
        .unwrap();
        assert_eq!(
            version(&package, "@scope/wrapper").as_deref(),
            Some("2.7.0")
        );
        assert_eq!(version(&package, "@scope/other"), None);
        // Found from the wrapper's folder, one level up; a blank version is none.
        assert_eq!(
            resolve_from(&package, "@openai/codex"),
            Some(nested.clone())
        );
        assert_eq!(version(&nested, "@openai/codex"), None);
        assert_eq!(resolve_from(&package, "@openai/missing"), None);
    }
}
