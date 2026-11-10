//! Resolve the Qoder CLI behind its Windows launchers, so codeg spawns the
//! real program instead of a cmd wrapper.
//!
//! On Windows the `qoder` command codeg resolves is a wrapper. The official
//! installer's `qoder.cmd` forwards `%*` to a PowerShell `-File` script, and
//! PowerShell's command-line parser strips the embedded quotes of a JSON
//! argument before the CLI ever sees it: `--settings {"mcp":{"lazyLoad":false}}`
//! arrives as `{mcp:{lazyLoad:false}}`, and qodercli exits with `config_error`
//! ~1s into the handshake (reproduced on a live 1.1.84). The dispatcher can
//! also hand the launch to an npm `qodercli.cmd` it finds on PATH, which puts
//! the same PowerShell hop in front of an npm-installed CLI, and npm's own
//! `qoder.cmd` starts Node twice per launch (the package's dispatcher script,
//! then the CLI). Resolving to the real entry — the native `qodercli.exe`, or
//! Node running the npm package's JavaScript entry — lets argv reach the CLI
//! as separate arguments, unquoted and unreparsed.
//!
//! The resolution deliberately starts from the installation
//! `commands::acp::resolve_npx_command_for` already picked (PATH, then
//! `~/.local/bin`, then the npm prefix), so codeg never launches a different
//! Qoder than the one the user sees installed. A wrapper codeg cannot place a
//! real CLI behind is an error with that wrapper's path, never a silent
//! switch to another installation. The dispatcher branch follows the same
//! order as `qoder-dispatcher.ps1`'s own `Find-Cli` (`QODER_CLI_BIN`, then a
//! `qodercli` on PATH, then the user-install location), and the npm branch
//! follows npm's own shim rule (its Node beside it, else PATH's Node), so a
//! manual `qoder` run and codeg's connect end up on the same CLI.
//!
//! PATH and PATHEXT overrides are read from the launch env case-insensitively,
//! just as Windows reads the child's environment.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

/// Which real program a resolved `qoder` command points at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum QoderInstallKind {
    /// A native `qodercli.exe` (official installer, or the same file named directly).
    NativeCli,
    /// An npm installation, run as `node <package entry>`.
    NpmPackage,
}

/// The direct-spawn launch: the program, the arguments that come before the
/// registry's, and what it was resolved from. Paths are absolute, so the
/// child's workspace cwd cannot reinterpret them.
#[derive(Debug, Clone)]
pub(crate) struct QoderWindowsLaunch {
    pub program: PathBuf,
    /// `[]` for a native CLI; the JavaScript entry for an npm install.
    pub prefix_args: Vec<OsString>,
    pub kind: QoderInstallKind,
}

impl QoderWindowsLaunch {
    /// `<program> <prefix_args> --version`: the version probe of the exact
    /// program codeg launches, so detection cannot read a different
    /// installation than the connect starts.
    pub(crate) fn version_probe_args(&self) -> Vec<String> {
        let mut args = self
            .prefix_args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        args.push("--version".to_string());
        args
    }

    /// A one-line description of the launch for diagnostics: the program and,
    /// for an npm install, the entry it runs.
    pub(crate) fn describe(&self) -> String {
        match self.kind {
            QoderInstallKind::NativeCli => self.program.to_string_lossy().into_owned(),
            QoderInstallKind::NpmPackage => format!(
                "{} {}",
                self.program.to_string_lossy(),
                self.prefix_args
                    .first()
                    .map(|a| a.to_string_lossy().into_owned())
                    .unwrap_or_default()
            ),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum LaunchError {
    #[error(
        "{0} is not a Qoder launcher codeg recognizes (neither the official installer's \
         dispatcher nor an npm shim). Run `qoder --version` in a terminal to check that \
         installation, or point a custom Qoder agent at the qodercli executable directly."
    )]
    UnknownWrapper(String),
    #[error(
        "The Qoder installation at {0} does not carry its npm package (no package.json \
         with a `bin.qodercli` entry above the launcher). Reinstall with \
         `npm install -g @qoder-ai/qodercli`."
    )]
    EntryMissing(String),
    #[error("QODER_CLI_BIN points at {0}, which is not an existing file. Use an absolute path to a qodercli executable, or clear it to use the installed CLI.")]
    CliBinInvalid(String),
    #[error(
        "The Qoder dispatcher at {0} found no qodercli to run. Install the Qoder CLI \
         (https://qoder.com), set QODER_CLI_BIN to its executable in Agent Settings, or \
         install it with npm."
    )]
    CliMissing(String),
    #[error("Node.js could not be found for the npm-installed Qoder CLI. Install Node.js, or run Qoder from its official installer instead.")]
    NodeMissing,
    #[error("Node.js resolved to {0}, which is not a native executable. Put node.exe on the agent's PATH, or use Qoder's official installer instead of launching through another wrapper.")]
    NodeWrapper(String),
    #[error("QODER_CLI_BIN must be an absolute path or a command name, not a relative path: {0}")]
    RelativeOverride(String),
    #[error("Could not resolve an absolute Qoder launch path for {path}: {source}")]
    PathResolution {
        path: String,
        source: std::io::Error,
    },
}

fn lower_extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// Windows also reads `C:qoder.exe` against drive C's current folder, so it is
/// no more resolvable than any other relative path.
fn is_relative_path(value: &str) -> bool {
    let value = value.trim();
    let path = Path::new(value);
    !path.is_absolute()
        && (value.contains('/')
            || value.contains('\\')
            || matches!(path.components().next(), Some(Component::Prefix(_))))
}

/// Anchor a resolved file to the process cwd, so the returned launch survives
/// a child with a different (workspace) cwd. Unlike cwd.join(), absolute()
/// also resolves drive-relative Windows paths such as C:tools\qodercli.exe.
fn absolutize(path: &Path) -> Result<PathBuf, LaunchError> {
    std::path::absolute(path).map_err(|source| LaunchError::PathResolution {
        path: path.display().to_string(),
        source,
    })
}

fn read_launcher(path: &Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > 32 * 1024 {
        return None;
    }
    // A native executable is not UTF-8 text and stops here.
    std::fs::read_to_string(path).ok()
}

/// The npm package root for a dispatcher script: the closest ancestor
/// directory whose `package.json` declares it, so the entry always comes from
/// the SAME installation the launcher belongs to.
fn package_root_for(dispatcher: &Path) -> Option<(PathBuf, serde_json::Value)> {
    for dir in dispatcher.ancestors().take(5) {
        let manifest = dir.join("package.json");
        let Ok(text) = std::fs::read_to_string(&manifest) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        if parsed
            .get("bin")
            .and_then(|bin| bin.get("qodercli"))
            .is_some()
        {
            return Some((dir.to_path_buf(), parsed));
        }
    }
    None
}

/// The `bin.qodercli` JavaScript entry of an npm package, given its root.
fn npm_entry(root: &Path, manifest: &serde_json::Value) -> Option<PathBuf> {
    let bin = manifest.get("bin")?.get("qodercli")?;
    let relative = bin.as_str()?;
    let entry = root.join(relative.replace('\\', "/"));
    entry.is_file().then_some(entry)
}

fn env_lookup(env: &BTreeMap<String, String>, key: &str) -> Option<String> {
    env.iter()
        .rev()
        .find(|(name, _)| name.eq_ignore_ascii_case(key))
        .map(|(_, value)| value.clone())
        .or_else(|| std::env::var(key).ok())
}

/// Resolve a program name through the launch env's PATH (falling back to the
/// process PATH), without consulting the workspace cwd: a `qodercli.exe`
/// committed to the repo must not shadow the installed CLI through cmd.exe's
/// current-directory-first search. Resolve PATHEXT locally: which caches the
/// process PATHEXT and cannot honor an agent's override.
fn which_in_path(program: &str, env: &BTreeMap<String, String>) -> Option<PathBuf> {
    let path = env_lookup(env, "PATH").unwrap_or_default();
    let pathext = env_lookup(env, "PATHEXT")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into());
    let extensions: Vec<_> = pathext
        .split(';')
        .filter(|ext| ext.starts_with('.') && ext.len() > 1)
        .map(str::to_ascii_lowercase)
        .collect();
    let mut names = Vec::new();
    if Path::new(program).extension().is_some() {
        names.push(program.to_string());
    }
    if !extensions
        .iter()
        .any(|ext| program.to_ascii_lowercase().ends_with(ext))
    {
        names.extend(extensions.iter().map(|ext| format!("{program}{ext}")));
    }
    // npm also writes an extensionless POSIX shell shim. Do not mistake that
    // file for the Windows command; only PATHEXT candidates answer bare names.
    std::env::split_paths(&path)
        .filter(|dir| !dir.as_os_str().is_empty())
        .filter_map(|dir| absolutize(&dir).ok())
        .find_map(|dir| {
            names.iter().find_map(|name| {
                let candidate = dir.join(name);
                candidate.is_file().then_some(candidate)
            })
        })
}

/// The Node npm's own shim uses: its `node.exe` beside the shims when present,
/// else PATH's `node` — the same two rules, the same order. No version gate:
/// an npm install whose Node is too old fails in the CLI's own startup error,
/// like every other npx agent's launch does.
fn npm_node(shim_dir: &Path, env: &BTreeMap<String, String>) -> Result<PathBuf, LaunchError> {
    let beside = shim_dir.join("node.exe");
    if beside.is_file() {
        return absolutize(&beside);
    }
    // npm's cmd shim excludes .JS before looking up Node, so an unrelated
    // node.js on an earlier PATH entry cannot shadow the native runtime.
    let mut node_env = env.clone();
    let pathext = env_lookup(env, "PATHEXT")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into());
    let node_pathext = pathext
        .split(';')
        .filter(|ext| !ext.eq_ignore_ascii_case(".JS"))
        .collect::<Vec<_>>()
        .join(";");
    if node_pathext.is_empty() {
        return Err(LaunchError::NodeMissing);
    }
    node_env.retain(|key, _| !key.eq_ignore_ascii_case("PATHEXT"));
    node_env.insert("PATHEXT".into(), node_pathext);
    let node = which_in_path("node", &node_env).ok_or(LaunchError::NodeMissing)?;
    if !matches!(lower_extension(&node).as_str(), "exe" | "com") {
        return Err(LaunchError::NodeWrapper(node.display().to_string()));
    }
    Ok(node)
}

fn native_launch(path: &Path) -> Result<QoderWindowsLaunch, LaunchError> {
    Ok(QoderWindowsLaunch {
        program: absolutize(path)?,
        prefix_args: Vec::new(),
        kind: QoderInstallKind::NativeCli,
    })
}

fn finish_npm(
    entry: &Path,
    shim_dir: &Path,
    env: &BTreeMap<String, String>,
) -> Result<QoderWindowsLaunch, LaunchError> {
    let node = npm_node(shim_dir, env)?;
    Ok(QoderWindowsLaunch {
        program: node,
        prefix_args: vec![absolutize(entry)?.into_os_string()],
        kind: QoderInstallKind::NpmPackage,
    })
}

/// The entry a launcher names relative to its own directory (`%dp0%\…`).
fn dp0_entry_pattern() -> Option<regex::Regex> {
    regex::Regex::new(r#"(?i)(?:%dp0%|%~dp0)[\\/]([^"\r\n]+?\.(?:cjs|mjs|js))"#).ok()
}

/// A cmd launcher written the way npm writes its shims runs a JavaScript file
/// from a path under its own directory — that is the shape of an npm shim for
/// any bin of the package, whether it names the package dispatcher
/// (`qoder.cmd`) or the CLI entry directly (`qodercli.cmd`).
fn looks_like_npm_shim(launcher: &str) -> bool {
    dp0_entry_pattern()
        .map(|pattern| pattern.is_match(launcher))
        .unwrap_or(false)
}

/// The launch for an npm shim: its launcher names a file under the package
/// tree, whose package's own `bin.qodercli` is the entry codeg runs.
fn npm_launch(
    shim: &Path,
    launcher: &str,
    env: &BTreeMap<String, String>,
) -> Result<QoderWindowsLaunch, LaunchError> {
    let Some(pattern) = dp0_entry_pattern() else {
        return Err(LaunchError::EntryMissing(shim.display().to_string()));
    };
    let dir = shim.parent().unwrap_or_else(|| Path::new("."));
    for captures in pattern.captures_iter(launcher) {
        let Some(relative) = captures.get(1) else {
            continue;
        };
        let named = dir.join(relative.as_str().replace('\\', "/"));
        if !named.is_file() {
            continue;
        }
        let Some((root, manifest)) = package_root_for(&named) else {
            continue;
        };
        let Some(entry) = npm_entry(&root, &manifest) else {
            continue;
        };
        return finish_npm(&entry, dir, env);
    }
    Err(LaunchError::EntryMissing(shim.display().to_string()))
}

/// Classify a target a dispatcher or a PATH hit leads to: only the two real
/// installations. A dispatcher behind a dispatcher is an error rather than a
/// walk — nesting that deep means the installation is not understood.
fn classify_target(
    path: &Path,
    env: &BTreeMap<String, String>,
) -> Result<QoderWindowsLaunch, LaunchError> {
    let extension = lower_extension(path);
    if matches!(extension.as_str(), "cmd" | "bat") {
        let launcher = read_launcher(path).unwrap_or_default();
        if !launcher.contains("qoder-dispatcher.ps1") && looks_like_npm_shim(&launcher) {
            return npm_launch(path, &launcher, env);
        }
        return Err(LaunchError::UnknownWrapper(path.display().to_string()));
    }
    classify(path, env)
}

/// Classify the file a `qoder` command resolved to: the real launch it leads
/// to, if any.
fn classify(
    path: &Path,
    env: &BTreeMap<String, String>,
) -> Result<QoderWindowsLaunch, LaunchError> {
    let extension = lower_extension(path);
    if matches!(extension.as_str(), "cmd" | "bat") {
        let launcher = read_launcher(path).unwrap_or_default();
        if launcher.contains("qoder-dispatcher.ps1") {
            return dispatcher_launch(path, env);
        }
        if looks_like_npm_shim(&launcher) {
            return npm_launch(path, &launcher, env);
        }
        return Err(LaunchError::UnknownWrapper(path.display().to_string()));
    }
    if matches!(extension.as_str(), "js" | "cjs" | "mjs") && path.is_file() {
        // A package entry named directly: run it with Node.
        let _ = package_root_for(path)
            .ok_or_else(|| LaunchError::EntryMissing(path.display().to_string()))?;
        return finish_npm(path, path.parent().unwrap_or(Path::new(".")), env);
    }
    if extension == "exe" && path.is_file() {
        // A `.exe` that is not really a PE image fails at spawn, the same way
        // spawning any other non-runnable file would.
        return native_launch(path);
    }
    Err(LaunchError::UnknownWrapper(path.display().to_string()))
}

/// The launch for the official installer's dispatcher, by the rules
/// `qoder-dispatcher.ps1` applies to itself: `QODER_CLI_BIN`, then a
/// `qodercli` on PATH (not the wrapper itself), then the user-install
/// location.
fn dispatcher_launch(
    dispatcher: &Path,
    env: &BTreeMap<String, String>,
) -> Result<QoderWindowsLaunch, LaunchError> {
    if let Some(explicit) =
        env_lookup(env, "QODER_CLI_BIN").filter(|value| !value.trim().is_empty())
    {
        if is_relative_path(&explicit) {
            return Err(LaunchError::RelativeOverride(explicit));
        }
        let resolved = if Path::new(&explicit).is_absolute() {
            PathBuf::from(&explicit)
        } else {
            which_in_path(&explicit, env)
                .ok_or_else(|| LaunchError::CliBinInvalid(explicit.clone()))?
        };
        if !resolved.is_file() {
            return Err(LaunchError::CliBinInvalid(explicit));
        }
        return classify_target(&resolved, env);
    }
    if let Some(found) = which_in_path("qodercli", env) {
        if !same_file(&found, dispatcher) {
            return classify_target(&found, env);
        }
    }
    let home = env_lookup(env, "USERPROFILE")
        .map(PathBuf::from)
        .or_else(dirs::home_dir);
    if let Some(home) = home {
        let user_bin = home.join(".qoder/bin/qodercli/qodercli.exe");
        if user_bin.is_file() {
            return native_launch(&user_bin);
        }
    }
    Err(LaunchError::CliMissing(dispatcher.display().to_string()))
}

fn same_file(left: &Path, right: &Path) -> bool {
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

/// Resolve a `qoder` command codeg has already located into a direct-spawn
/// launch. Filesystem and PATH work only.
pub(crate) fn resolve_launch(
    resolved: &Path,
    env: &BTreeMap<String, String>,
) -> Result<QoderWindowsLaunch, LaunchError> {
    classify(&absolutize(resolved)?, env)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A fake npm install: official npm shims for both bins in `bin`, the
    /// package under the shims' own `node_modules`, and (optionally) a Node
    /// beside the shims. Returns the `qoder.cmd` shim path.
    pub(crate) fn npm_fixture(root: &Path, node_beside_shim: bool) -> PathBuf {
        let bin = root.join("bin");
        let pkg = bin.join("node_modules/@qoder-ai/qodercli");
        std::fs::create_dir_all(pkg.join("bundle")).unwrap();
        std::fs::write(
            bin.join("qoder.cmd"),
            "@ECHO off\r\nSET dp0=%~dp0%\r\n\"%_prog%\" \"%dp0%\\node_modules\\@qoder-ai\\qodercli\\bundle\\qoder-npm-dispatcher.cjs\" %*\r\n",
        )
        .unwrap();
        std::fs::write(
            bin.join("qodercli.cmd"),
            "@ECHO off\r\nSET dp0=%~dp0%\r\n\"%_prog%\" \"%dp0%\\node_modules\\@qoder-ai\\qodercli\\bundle\\qodercli.js\" %*\r\n",
        )
        .unwrap();
        std::fs::write(pkg.join("bundle/qoder-npm-dispatcher.cjs"), "//").unwrap();
        std::fs::write(
            pkg.join("package.json"),
            r#"{"name":"@qoder-ai/qodercli","version":"1.1.84","bin":{"qodercli":"bundle/qodercli.js","qoder":"bundle/qoder-npm-dispatcher.cjs"},"engines":{"node":">=20.0.0"}}"#,
        )
        .unwrap();
        std::fs::write(pkg.join("bundle/qodercli.js"), "// entry").unwrap();
        if node_beside_shim {
            std::fs::write(bin.join("node.exe"), b"MZ fake").unwrap();
        }
        bin.join("qoder.cmd")
    }

    /// The official installer's dispatcher stub (its cmd half).
    pub(crate) fn dispatcher_fixture(root: &Path) -> PathBuf {
        let path = root.join("entry/qoder.cmd");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            "@echo off\r\nset \"DISPATCHER=%~dp0qoder-dispatcher.ps1\"\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%DISPATCHER%\" -- %*\r\n",
        )
        .unwrap();
        path
    }

    fn empty_env() -> BTreeMap<String, String> {
        // An empty PATH key means "this PATH", not "inherit the process's".
        BTreeMap::from([
            ("PATH".to_string(), String::new()),
            ("PATHEXT".to_string(), ".COM;.EXE;.BAT;.CMD".to_string()),
            ("QODER_CLI_BIN".to_string(), String::new()),
        ])
    }

    #[test]
    fn npm_shim_resolves_to_its_own_package_entry() {
        let root = tempfile::tempdir().unwrap();
        let shim = npm_fixture(root.path(), true);
        let launch =
            resolve_launch(&shim, &empty_env()).expect("the npm shim leads to its package");
        assert_eq!(launch.kind, QoderInstallKind::NpmPackage);
        assert_eq!(launch.prefix_args.len(), 1);
        assert!(launch.program.is_absolute() && Path::new(&launch.prefix_args[0]).is_absolute());
        // Path equality folds the separator spellings the join leaves mixed.
        assert_eq!(
            Path::new(&launch.prefix_args[0]),
            root.path()
                .join("bin/node_modules/@qoder-ai/qodercli/bundle/qodercli.js")
        );
        // The Node npm ships beside its shims wins, as it does in the shim.
        assert_eq!(launch.program, root.path().join("bin/node.exe"));
        assert_eq!(launch.version_probe_args()[1], "--version");
    }

    /// npm also writes a `qodercli.cmd` that names the CLI entry directly,
    /// without the package dispatcher: the same resolution must reach the
    /// same entry through it.
    #[test]
    fn the_direct_entry_npm_shim_resolves_to_the_same_entry() {
        let root = tempfile::tempdir().unwrap();
        npm_fixture(root.path(), true);
        let shim = root.path().join("bin/qodercli.cmd");
        let launch = resolve_launch(&shim, &empty_env())
            .expect("the direct-entry shim leads to its package");
        assert_eq!(launch.kind, QoderInstallKind::NpmPackage);
        assert_eq!(launch.prefix_args.len(), 1);
        assert_eq!(
            Path::new(&launch.prefix_args[0]),
            root.path()
                .join("bin/node_modules/@qoder-ai/qodercli/bundle/qodercli.js")
        );
    }

    #[test]
    fn package_metadata_under_bundle_does_not_hide_the_package_entry() {
        let root = tempfile::tempdir().unwrap();
        let shim = npm_fixture(root.path(), true);
        let bundle = root
            .path()
            .join("bin/node_modules/@qoder-ai/qodercli/bundle");
        std::fs::write(bundle.join("package.json"), r#"{"type":"commonjs"}"#).unwrap();
        let launch = resolve_launch(&shim, &empty_env()).unwrap();
        assert_eq!(
            Path::new(&launch.prefix_args[0]),
            bundle.join("qodercli.js")
        );
    }

    /// Without a Node beside the shims, npm's own fallback is PATH's node —
    /// resolved against the LAUNCH env's PATH, case-insensitively keyed, and
    /// anchored to an absolute path.
    #[test]
    fn npm_shim_without_a_beside_node_takes_the_launch_env_path() {
        let root = tempfile::tempdir().unwrap();
        let shim = npm_fixture(root.path(), false);
        let node_dir = root.path().join("node");
        std::fs::create_dir_all(&node_dir).unwrap();
        let node = node_dir.join("node.exe");
        std::fs::write(&node, b"MZ fake").unwrap();
        let mut env = empty_env();
        env.remove("PATH");
        // A lowercase `Path` key is the same override as `PATH`.
        env.insert("Path".to_string(), node_dir.to_string_lossy().into_owned());
        let launch = resolve_launch(&shim, &env).expect("PATH answers for the missing beside Node");
        assert_eq!(launch.program, node);
    }

    #[test]
    fn path_lookup_honors_the_launch_pathext_and_skips_the_posix_shim() {
        let root = tempfile::tempdir().unwrap();
        let exe = root.path().join("qodercli.exe");
        let cmd = root.path().join("qodercli.cmd");
        std::fs::write(&exe, b"MZ fake").unwrap();
        std::fs::write(&cmd, "@echo off").unwrap();
        std::fs::write(root.path().join("qodercli"), "#!/bin/sh\n").unwrap();
        let mut env = empty_env();
        env.insert("PATH".into(), root.path().to_string_lossy().into_owned());
        env.insert("Pathext".into(), ".CMD;.EXE".into());
        assert_eq!(which_in_path("qodercli", &env), Some(cmd));
        env.insert("Pathext".into(), ".EXE;.CMD".into());
        assert_eq!(which_in_path("qodercli", &env), Some(exe));
    }

    #[test]
    fn case_insensitive_env_duplicates_follow_the_childs_last_assignment() {
        let env = BTreeMap::from([
            ("PATH".into(), "first".into()),
            ("Path".into(), "last".into()),
        ]);
        assert_eq!(env_lookup(&env, "PATH").as_deref(), Some("last"));
    }

    #[test]
    fn npm_launch_rejects_a_node_cmd_wrapper() {
        let root = tempfile::tempdir().unwrap();
        let shim = npm_fixture(root.path(), false);
        let node_dir = root.path().join("node");
        std::fs::create_dir_all(&node_dir).unwrap();
        let wrapper = node_dir.join("node.cmd");
        std::fs::write(&wrapper, "@echo off\nnode.exe %*\n").unwrap();
        let mut env = empty_env();
        env.insert("PATH".into(), node_dir.to_string_lossy().into_owned());
        assert!(matches!(
            resolve_launch(&shim, &env),
            Err(LaunchError::NodeWrapper(path)) if Path::new(&path) == wrapper
        ));
    }

    #[test]
    fn npm_node_lookup_excludes_js_like_the_npm_shim() {
        let root = tempfile::tempdir().unwrap();
        let shim = npm_fixture(root.path(), false);
        let scripts = root.path().join("scripts");
        let native = root.path().join("native");
        std::fs::create_dir_all(&scripts).unwrap();
        std::fs::create_dir_all(&native).unwrap();
        std::fs::write(scripts.join("node.js"), "// not a Node runtime").unwrap();
        let node = native.join("node.exe");
        std::fs::write(&node, b"MZ fake").unwrap();
        let mut env = empty_env();
        env.insert(
            "PATH".into(),
            std::env::join_paths([scripts, native])
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        );
        env.insert("PATHEXT".into(), ".EXE;.JS;.CMD".into());
        assert_eq!(resolve_launch(&shim, &env).unwrap().program, node);
    }

    #[test]
    fn npm_launch_reports_a_missing_node_or_entry() {
        let root = tempfile::tempdir().unwrap();
        let shim = npm_fixture(root.path(), false);
        assert!(matches!(
            resolve_launch(&shim, &empty_env()),
            Err(LaunchError::NodeMissing)
        ));
        std::fs::remove_file(
            root.path()
                .join("bin/node_modules/@qoder-ai/qodercli/bundle/qodercli.js"),
        )
        .unwrap();
        assert!(matches!(
            resolve_launch(&shim, &empty_env()),
            Err(LaunchError::EntryMissing(_))
        ));
    }

    #[test]
    fn dispatcher_follows_qoder_cli_bin() {
        let root = tempfile::tempdir().unwrap();
        let dispatcher = dispatcher_fixture(root.path());
        let cli = root.path().join("somewhere/qodercli.exe");
        std::fs::create_dir_all(cli.parent().unwrap()).unwrap();
        std::fs::write(&cli, b"MZ fake").unwrap();
        let mut env = empty_env();
        env.insert(
            "QODER_CLI_BIN".to_string(),
            cli.to_string_lossy().into_owned(),
        );
        let launch = resolve_launch(&dispatcher, &env).expect("QODER_CLI_BIN wins");
        assert_eq!(launch.kind, QoderInstallKind::NativeCli);
        assert_eq!(launch.program, cli);
        let other = root.path().join("other.exe");
        std::fs::write(&other, b"MZ fake").unwrap();
        env.insert("qoder_cli_bin".into(), other.to_string_lossy().into_owned());
        assert_eq!(resolve_launch(&dispatcher, &env).unwrap().program, other);
    }

    #[test]
    fn dispatcher_qoder_cli_bin_must_be_absolute_and_exist() {
        let root = tempfile::tempdir().unwrap();
        let dispatcher = dispatcher_fixture(root.path());
        let mut env = empty_env();
        env.insert("QODER_CLI_BIN".to_string(), "sub\\qodercli.exe".to_string());
        assert!(matches!(
            resolve_launch(&dispatcher, &env),
            Err(LaunchError::RelativeOverride(_))
        ));
        let mut env = empty_env();
        env.insert(
            "QODER_CLI_BIN".to_string(),
            root.path()
                .join("missing.exe")
                .to_string_lossy()
                .into_owned(),
        );
        assert!(matches!(
            resolve_launch(&dispatcher, &env),
            Err(LaunchError::CliBinInvalid(_))
        ));
    }

    #[test]
    fn dispatcher_follows_a_qodercli_npm_shim_on_path() {
        let root = tempfile::tempdir().unwrap();
        let dispatcher = dispatcher_fixture(root.path());
        let shim_bin = npm_fixture(root.path(), true);
        let mut env = empty_env();
        env.insert(
            "PATH".to_string(),
            shim_bin.parent().unwrap().to_string_lossy().into_owned(),
        );
        let launch = resolve_launch(&dispatcher, &env).expect("the PATH npm shim answers");
        assert_eq!(launch.kind, QoderInstallKind::NpmPackage);
    }

    /// A dispatcher pointed at another dispatcher is not walked: nesting that
    /// deep means codeg would be guessing which installation answers.
    #[test]
    fn a_dispatcher_behind_the_dispatcher_is_an_error() {
        let root = tempfile::tempdir().unwrap();
        let dispatcher = dispatcher_fixture(root.path());
        let nested = dispatcher_fixture(&root.path().join("other"));
        let mut env = empty_env();
        env.insert(
            "QODER_CLI_BIN".to_string(),
            nested.to_string_lossy().into_owned(),
        );
        assert!(matches!(
            resolve_launch(&dispatcher, &env),
            Err(LaunchError::UnknownWrapper(_))
        ));
    }

    #[test]
    fn dispatcher_falls_back_to_the_user_install_then_gives_up() {
        let root = tempfile::tempdir().unwrap();
        let dispatcher = dispatcher_fixture(root.path());
        let home = root.path().join("home");
        let user_bin = home.join(".qoder/bin/qodercli/qodercli.exe");
        std::fs::create_dir_all(user_bin.parent().unwrap()).unwrap();
        std::fs::write(&user_bin, b"MZ fake").unwrap();
        let mut env = empty_env();
        env.insert(
            "USERPROFILE".to_string(),
            home.to_string_lossy().into_owned(),
        );
        let launch = resolve_launch(&dispatcher, &env).expect("the user install answers");
        assert_eq!(launch.kind, QoderInstallKind::NativeCli);
        assert_eq!(launch.program, user_bin);
        std::fs::remove_file(&user_bin).unwrap();
        assert!(matches!(
            resolve_launch(&dispatcher, &env),
            Err(LaunchError::CliMissing(_))
        ));
    }

    #[test]
    fn unknown_wrapper_is_an_error_not_a_fallback() {
        let root = tempfile::tempdir().unwrap();
        let wrapper = root.path().join("qoder.cmd");
        std::fs::write(&wrapper, "@echo off\r\necho hello\r\n").unwrap();
        assert!(matches!(
            resolve_launch(&wrapper, &empty_env()),
            Err(LaunchError::UnknownWrapper(_))
        ));
    }

    /// A relative PATH entry resolves against the process cwd, the way
    /// Windows would; the returned paths must already be anchored so a child
    /// with a workspace cwd cannot reinterpret them.
    #[test]
    fn relative_resolutions_are_anchored_to_absolute_paths() {
        assert!(absolutize(Path::new("tools/qodercli.exe"))
            .unwrap()
            .is_absolute());
        let absolute = std::env::current_dir().unwrap().join("qodercli.exe");
        assert_eq!(absolutize(&absolute).unwrap(), absolute);
    }

    #[cfg(windows)]
    #[test]
    fn drive_relative_resolutions_are_anchored_before_the_child_changes_cwd() {
        for path in ["C:tools\\qodercli.exe", "C:node.exe", "\\tools\\node.exe"] {
            assert!(absolutize(Path::new(path)).unwrap().is_absolute(), "{path}");
        }
    }

    #[test]
    fn a_path_with_cmd_metacharacters_still_resolves() {
        // Spaces, an ampersand, and a literal `%USERNAME%` directory name:
        // the resolution is filesystem-level, so argv reaches the CLI whole
        // regardless of what a cmd reparse of these paths would do.
        let root = tempfile::tempdir().unwrap();
        let tricky = root.path().join("Temp A&%USERNAME% 中文");
        std::fs::create_dir_all(&tricky).unwrap();
        let shim = npm_fixture(&tricky, true);
        let launch = resolve_launch(&shim, &empty_env()).expect("the tricky path resolves");
        assert_eq!(launch.kind, QoderInstallKind::NpmPackage);
        assert!(launch.prefix_args[0]
            .to_string_lossy()
            .contains("%USERNAME%"));
    }

    /// The full Windows promise, against a real Node: what codeg's launch
    /// builds is what the CLI process receives, one argv entry per part,
    /// through a path with cmd metacharacters.
    #[tokio::test]
    async fn a_launched_entry_receives_the_settings_json_untouched() {
        let node = crate::commands::acp::resolve_command_on_path("node")
            .expect("the fixture test needs a real node");
        let root = tempfile::tempdir().unwrap();
        let tricky = root.path().join("Temp A&%USERNAME% 中文");
        let shim = npm_fixture(&tricky, false);
        let bin = shim.parent().unwrap();
        let pkg = bin.join("node_modules/@qoder-ai/qodercli");
        let entry = pkg.join("bundle/qodercli.js");
        std::fs::write(
            &entry,
            "console.log(JSON.stringify({argv: process.argv.slice(1), cwd: process.cwd()}));\n",
        )
        .unwrap();
        // Exercise metacharacters in the executable as well as the entry and
        // workspace, with a child cwd different from the resolver's cwd.
        let node_dir = tricky.join("Node");
        std::fs::create_dir_all(&node_dir).unwrap();
        let native_node = node_dir.join("node.exe");
        let real_node = std::fs::canonicalize(node).unwrap();
        // A copy is self-contained only on Windows: Homebrew's macOS node
        // loads `@rpath/libnode.dylib` relative to its real location, which a
        // symlink keeps and a copy loses.
        #[cfg(windows)]
        std::fs::copy(&real_node, &native_node).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real_node, &native_node).unwrap();
        let workspace = tricky.join("Workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let mut env = empty_env();
        env.insert(
            "PATH".into(),
            std::env::join_paths([bin, &node_dir])
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        );
        let dispatcher = dispatcher_fixture(root.path());
        for launcher in [&shim, &dispatcher] {
            let launch = resolve_launch(launcher, &env).expect("the fixture resolves");
            assert_eq!(launch.program, native_node);
            let mut command = crate::process::tokio_command(&launch.program);
            command
                .args(&launch.prefix_args)
                .args([
                    "--acp",
                    "--settings",
                    crate::acp::connection::QODER_LAUNCH_SETTINGS,
                ])
                .current_dir(&workspace)
                .kill_on_drop(true);
            let output = tokio::time::timeout(std::time::Duration::from_secs(30), command.output())
                .await
                .expect("node runs")
                .expect("node spawns");
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let received: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            let argv: Vec<String> = serde_json::from_value(received["argv"].clone()).unwrap();
            assert_eq!(argv.len(), 4, "{argv:?}");
            assert_eq!(Path::new(&argv[0]), entry);
            assert_eq!(
                std::fs::canonicalize(received["cwd"].as_str().unwrap()).unwrap(),
                std::fs::canonicalize(&workspace).unwrap()
            );
            assert_eq!(
                &argv[1..],
                [
                    "--acp".to_string(),
                    "--settings".to_string(),
                    crate::acp::connection::QODER_LAUNCH_SETTINGS.to_string(),
                ]
            );
        }
    }
}
