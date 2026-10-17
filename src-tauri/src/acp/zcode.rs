//! Resolve the official ZCode runtime separately from the npm ACP bridge.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct ZCodeRuntime {
    pub cli: PathBuf,
    pub node: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error("Official ZCode CLI could not be found. Install ZCode and sign in, or set ZCODE_BIN to its zcode.cjs entry in Agent Settings.")]
    CliMissing,
    #[error("ZCODE_BIN does not resolve to a supported ZCode entry: {0}. Use zcode.cjs, zcode.mjs, or a native executable.")]
    CliInvalid(String),
    #[error("Node.js could not be found. Install Node.js 22 or newer, or set ZCODE_NODE in Agent Settings.")]
    NodeMissing,
    #[error("ZCODE_NODE does not resolve to a Node executable: {0}")]
    NodeInvalid(String),
    #[error("The ZCode Node runtime must be Node.js 22 or newer with node:sqlite available. Check ZCODE_NODE in Agent Settings.")]
    NodeUnsupported,
    #[error("{0} must be an absolute path or a command name on PATH: {1}")]
    RelativeOverride(&'static str, String),
}

fn same_env_key(name: &str, key: &str) -> bool {
    if cfg!(windows) {
        name.eq_ignore_ascii_case(key)
    } else {
        name == key
    }
}

impl ZCodeRuntime {
    pub fn apply(&self, env: &mut Vec<(String, String)>) {
        for (key, value) in [
            ("ZCODE_BIN", self.cli.to_string_lossy().into_owned()),
            ("ZCODE_NODE", self.node.to_string_lossy().into_owned()),
            ("ZCODE_ACP_REMOTE", "0".to_string()),
        ] {
            env.retain(|(name, _)| !same_env_key(name, key));
            env.push((key.to_string(), value));
        }
        // The bridge re-executes itself under Bun >= 1.4 when it finds one.
        // Keep it on the Node validated above unless the agent's own
        // environment chose a runtime.
        if !env
            .iter()
            .any(|(name, _)| same_env_key(name, "ZCODE_ACP_RUNTIME"))
        {
            env.push(("ZCODE_ACP_RUNTIME".to_string(), "node".to_string()));
        }
    }
}

/// A blank explicit value removes inheritance and opts back into discovery.
fn effective_env(overrides: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    for key in ["ZCODE_BIN", "ZCODE_NODE", "PATH", "LOCALAPPDATA"] {
        let explicit = overrides.iter().find(|(name, _)| {
            if cfg!(windows) {
                name.eq_ignore_ascii_case(key)
            } else {
                *name == key
            }
        });
        let value = explicit
            .map(|(_, value)| value.clone())
            .or_else(|| std::env::var(key).ok());
        if let Some(value) = value {
            if key == "PATH" || !value.trim().is_empty() {
                env.insert(key.to_string(), value);
            }
        }
    }
    env
}

/// A relative path has no base an override could mean: each workspace would
/// resolve it against its own folder, and preflight has no workspace at all.
/// Windows also reads `C:node.exe` against drive C's current folder.
fn is_relative_path(value: &str) -> bool {
    let value = value.trim();
    let path = Path::new(value);
    !path.is_absolute()
        && (value.contains('/')
            || value.contains('\\')
            || matches!(
                path.components().next(),
                Some(std::path::Component::Prefix(_))
            ))
}

fn resolve_program(value: &str, env: &BTreeMap<String, String>, cwd: &Path) -> Option<PathBuf> {
    let value = value.trim();
    let path = Path::new(value);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else if is_relative_path(value) {
        return None;
    } else {
        which::which_in(
            value,
            Some(std::ffi::OsString::from(
                env.get("PATH").map(String::as_str).unwrap_or(""),
            )),
            cwd,
        )
        .ok()?
    };
    resolved.is_file().then_some(resolved)
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn is_js(path: &Path) -> bool {
    matches!(extension_of(path).as_str(), "cjs" | "mjs" | "js")
}

/// The JavaScript file behind a command: the file itself, the target an npm
/// link points at, or the entry an npm/pnpm launcher names relative to its
/// own directory (`%dp0%\…`, `%~dp0\…`, `$basedir/…`). Reads the launcher
/// without running it or changing the user's installation.
fn js_entry(path: &Path) -> Option<PathBuf> {
    let extension = extension_of(path);
    if is_js(path) {
        return path.is_file().then(|| path.to_path_buf());
    }
    if !matches!(extension.as_str(), "" | "cmd") {
        return None;
    }
    if cfg!(unix) && extension.is_empty() {
        if let Ok(target) = std::fs::canonicalize(path) {
            if is_js(&target) && target.is_file() {
                return Some(target);
            }
        }
    }
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > 32 * 1024 {
        return None;
    }
    // A native launcher is not UTF-8 and stops here.
    let launcher = std::fs::read_to_string(path).ok()?;
    let pattern =
        regex::Regex::new(r#"(?i)(?:%dp0%|%~dp0|\$basedir)[\\/]([^"\r\n]+?\.(?:cjs|mjs|js))"#)
            .ok()?;
    let dir = path.parent()?;
    for captures in pattern.captures_iter(&launcher) {
        let Some(relative) = captures.get(1) else {
            continue;
        };
        let entry = dir.join(relative.as_str().replace('\\', "/"));
        if entry.is_file() {
            return Some(entry);
        }
    }
    None
}

/// The bridge's JavaScript entry. Codeg runs it with the validated Node, so a
/// launcher that names no entry (a native shim) cannot be used.
pub(crate) fn bridge_entry(command: &Path) -> Option<PathBuf> {
    js_entry(command)
}

pub(crate) fn bridge_entry_missing_message(command: &str) -> String {
    format!(
        "The ZCode ACP bridge found at {command} does not lead to its JavaScript entry, which Codeg runs with the validated Node. Remove that installation from PATH or reinstall the bridge with npm."
    )
}

/// The official CLI as ZCODE_BIN. The bridge runs a JavaScript entry with
/// ZCODE_NODE and anything else directly, through its own shebang on
/// whichever `node` comes first in PATH, so prefer the entry behind a
/// launcher or link and fall back to a native executable.
pub(crate) fn cli_entry(path: &Path) -> Option<PathBuf> {
    js_entry(path).or_else(|| {
        (matches!(extension_of(path).as_str(), "" | "exe") && path.is_file())
            .then(|| path.to_path_buf())
    })
}

fn bundled_candidates(platform: &str, home: Option<&Path>, local: Option<&str>) -> Vec<PathBuf> {
    match platform {
        "windows" => local
            .map(PathBuf::from)
            .or_else(|| home.map(|home| home.join("AppData/Local")))
            .map(|base| vec![base.join("Programs/ZCode/resources/glm/zcode.cjs")])
            .unwrap_or_default(),
        "macos" => {
            let mut paths = vec![PathBuf::from(
                "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
            )];
            if let Some(home) = home {
                paths.push(home.join("Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"));
            }
            paths
        }
        _ => vec![
            PathBuf::from("/opt/ZCode/resources/glm/zcode.cjs"),
            PathBuf::from("/usr/share/zcode/resources/glm/zcode.cjs"),
        ],
    }
}

fn resolve_cli(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    home: Option<&Path>,
    platform: &str,
) -> Result<PathBuf, RuntimeError> {
    let cli = if let Some(explicit) = env.get("ZCODE_BIN") {
        if is_relative_path(explicit) {
            return Err(RuntimeError::RelativeOverride(
                "ZCODE_BIN",
                explicit.clone(),
            ));
        }
        resolve_program(explicit, env, cwd)
            .and_then(|path| cli_entry(&path))
            .ok_or_else(|| RuntimeError::CliInvalid(explicit.clone()))?
    } else {
        // Prefer the canonical desktop JS entry over a PATH .cmd launcher.
        bundled_candidates(platform, home, env.get("LOCALAPPDATA").map(String::as_str))
            .iter()
            .find_map(|path| cli_entry(path))
            .or_else(|| resolve_program("zcode", env, cwd).and_then(|path| cli_entry(&path)))
            .ok_or(RuntimeError::CliMissing)?
    };
    Ok(cli)
}

pub(crate) fn resolve_cli_path(
    overrides: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<PathBuf, RuntimeError> {
    resolve_cli(
        &effective_env(overrides),
        cwd,
        dirs::home_dir().as_deref(),
        std::env::consts::OS,
    )
}

/// Node executables to try, best first. An explicit ZCODE_NODE is the only
/// candidate: a broken override is reported, never replaced by another Node.
fn node_candidates(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    home: Option<&Path>,
    platform: &str,
) -> Result<Vec<PathBuf>, RuntimeError> {
    if let Some(explicit) = env.get("ZCODE_NODE") {
        if is_relative_path(explicit) {
            return Err(RuntimeError::RelativeOverride(
                "ZCODE_NODE",
                explicit.clone(),
            ));
        }
        return resolve_program(explicit, env, cwd)
            .map(|node| vec![node])
            .ok_or_else(|| RuntimeError::NodeInvalid(explicit.clone()));
    }
    discovered_nodes(
        env,
        cwd,
        platform,
        crate::process::node_bin_dir_candidates(home),
    )
}

/// PATH's `node`, then Node version-manager installs (`manager_dirs`), then
/// the Windows installer's default location.
fn discovered_nodes(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    platform: &str,
    manager_dirs: Vec<PathBuf>,
) -> Result<Vec<PathBuf>, RuntimeError> {
    let mut candidates: Vec<PathBuf> = resolve_program("node", env, cwd).into_iter().collect();
    candidates.extend(
        manager_dirs
            .into_iter()
            .map(|dir| dir.join(if cfg!(windows) { "node.exe" } else { "node" }))
            .filter(|path| path.is_file()),
    );
    if platform == "windows" {
        if let Some(base) = std::env::var_os("ProgramFiles") {
            let node = PathBuf::from(base).join("nodejs/node.exe");
            if node.is_file() {
                candidates.push(node);
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    candidates.retain(|node| seen.insert(node.clone()));
    if candidates.is_empty() {
        Err(RuntimeError::NodeMissing)
    } else {
        Ok(candidates)
    }
}

#[cfg(test)]
fn resolve_paths(
    env: &BTreeMap<String, String>,
    cwd: &Path,
    home: Option<&Path>,
    platform: &str,
) -> Result<ZCodeRuntime, RuntimeError> {
    let cli = resolve_cli(env, cwd, home, platform)?;
    let node = node_candidates(env, cwd, home, platform)?.swap_remove(0);
    Ok(ZCodeRuntime { cli, node })
}

/// Node 22+ whose `node:sqlite` loads without a flag, which ZCode requires.
async fn node_supports_zcode(node: &Path, path: Option<&String>) -> bool {
    let mut command = crate::process::tokio_command(node);
    command.args(["-e", "if(Number(process.versions.node.split('.')[0])<22)process.exit(2);new (require('node:sqlite').DatabaseSync)(':memory:')"]);
    command.kill_on_drop(true);
    if let Some(path) = path {
        command.env("PATH", path);
    }
    let output = tokio::time::timeout(Duration::from_secs(5), command.output()).await;
    matches!(output, Ok(Ok(ref output)) if output.status.success())
}

/// The first candidate that can run ZCode. Like the bridge's own discovery,
/// an old Node first on PATH must not hide a newer one from a version manager.
async fn first_supported_node(candidates: Vec<PathBuf>, path: Option<&String>) -> Option<PathBuf> {
    for node in candidates {
        if node_supports_zcode(&node, path).await {
            return Some(node);
        }
    }
    None
}

pub async fn resolve_runtime(
    overrides: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<ZCodeRuntime, RuntimeError> {
    let env = effective_env(overrides);
    let home = dirs::home_dir();
    let platform = std::env::consts::OS;
    let cli = resolve_cli(&env, cwd, home.as_deref(), platform)?;
    let candidates = node_candidates(&env, cwd, home.as_deref(), platform)?;
    let node = first_supported_node(candidates, env.get("PATH"))
        .await
        .ok_or(RuntimeError::NodeUnsupported)?;
    Ok(ZCodeRuntime { cli, node })
}

pub fn initial_mode(
    preferred_mode: Option<&str>,
    preferred_config: &BTreeMap<String, String>,
    available: &[String],
) -> String {
    preferred_config
        .get("mode")
        .map(String::as_str)
        .into_iter()
        .chain(preferred_mode)
        .find(|mode| !mode.is_empty() && available.iter().any(|id| id == mode))
        .unwrap_or("build")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "").unwrap();
    }

    #[test]
    fn explicit_paths_with_spaces_win_over_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("My ZCode/zcode.cjs");
        let node = dir.path().join("My Node/node.exe");
        file(&cli);
        file(&node);
        let env = BTreeMap::from([
            ("ZCODE_BIN".into(), cli.display().to_string()),
            ("ZCODE_NODE".into(), node.display().to_string()),
            ("LOCALAPPDATA".into(), dir.path().display().to_string()),
        ]);
        let runtime = resolve_paths(&env, dir.path(), Some(dir.path()), "windows").unwrap();
        assert_eq!(runtime.cli, cli);
        assert_eq!(runtime.node, node);
    }

    #[test]
    fn invalid_explicit_cli_does_not_fall_back_to_bundle() {
        let dir = tempfile::tempdir().unwrap();
        file(&dir.path().join("Programs/ZCode/resources/glm/zcode.cjs"));
        let env = BTreeMap::from([
            (
                "ZCODE_BIN".into(),
                dir.path().join("missing.cjs").display().to_string(),
            ),
            ("LOCALAPPDATA".into(), dir.path().display().to_string()),
        ]);
        assert!(matches!(
            resolve_paths(&env, dir.path(), None, "windows"),
            Err(RuntimeError::CliInvalid(_))
        ));
    }

    #[test]
    fn bundle_discovery_does_not_require_shell_path() {
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("Programs/ZCode/resources/glm/zcode.cjs");
        let node = dir.path().join("Node/node.exe");
        file(&cli);
        file(&node);
        let env = BTreeMap::from([
            ("LOCALAPPDATA".into(), dir.path().display().to_string()),
            ("ZCODE_NODE".into(), node.display().to_string()),
            ("PATH".into(), String::new()),
        ]);
        let runtime = resolve_paths(&env, dir.path(), None, "windows").unwrap();
        assert_eq!(runtime.cli, cli);
    }

    #[test]
    fn windows_shim_resolves_js_target_without_spawning_cmd() {
        let dir = tempfile::tempdir().unwrap();
        let shim = dir.path().join("zcode.cmd");
        let entry = dir.path().join("node_modules/zcode/bin/zcode.mjs");
        file(&entry);
        std::fs::write(
            &shim,
            r#""%_prog%" "%dp0%\node_modules\zcode\bin\zcode.mjs" %*"#,
        )
        .unwrap();
        assert_eq!(cli_entry(&shim), Some(entry));
        std::fs::write(&shim, "unknown wrapper").unwrap();
        assert_eq!(cli_entry(&shim), None);
    }

    #[test]
    fn runtime_injection_replaces_keys_without_enabling_remote_hub() {
        let runtime = ZCodeRuntime {
            cli: "cli.cjs".into(),
            node: "node.exe".into(),
        };
        let mut env = vec![
            ("ZCODE_NODE".into(), "old".into()),
            ("ZCODE_ACP_REMOTE".into(), "1".into()),
        ];
        runtime.apply(&mut env);
        assert_eq!(env.iter().filter(|(key, _)| key == "ZCODE_NODE").count(), 1);
        assert!(env.contains(&("ZCODE_ACP_REMOTE".into(), "0".into())));
        // The bridge stays on the validated Node instead of re-executing
        // itself under a Bun it finds, unless the agent env picked a runtime.
        assert!(env.contains(&("ZCODE_ACP_RUNTIME".into(), "node".into())));
        let mut chosen = vec![("ZCODE_ACP_RUNTIME".to_string(), "bun".to_string())];
        runtime.apply(&mut chosen);
        let runtimes: Vec<_> = chosen
            .iter()
            .filter(|(key, _)| key == "ZCODE_ACP_RUNTIME")
            .collect();
        assert_eq!(
            runtimes,
            vec![&("ZCODE_ACP_RUNTIME".to_string(), "bun".to_string())]
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_path_link_to_the_cli_resolves_to_its_js_entry() {
        let dir = tempfile::tempdir().unwrap();
        let entry = dir.path().join("lib/node_modules/zcode/bin/zcode.mjs");
        file(&entry);
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let link = bin.join("zcode");
        std::os::unix::fs::symlink(&entry, &link).unwrap();
        // The bridge runs only a JS entry with ZCODE_NODE; the link itself
        // would run through its shebang on whichever node PATH offers.
        assert_eq!(
            cli_entry(&link),
            Some(std::fs::canonicalize(&entry).unwrap())
        );
        let native = bin.join("zcode-native");
        file(&native);
        assert_eq!(cli_entry(&native), Some(native.clone()));
    }

    #[test]
    fn bridge_launchers_lead_to_the_js_entry_node_runs() {
        let dir = tempfile::tempdir().unwrap();
        let entry = dir
            .path()
            .join("global/5/node_modules/zcode-acp-server/dist/cli.js");
        file(&entry);
        // pnpm's Unix launcher: running it under Node would be a syntax error.
        let sh = dir.path().join("zcode-acp-server");
        std::fs::write(
            &sh,
            "#!/bin/sh\nbasedir=$(dirname \"$(echo \"$0\" | sed -e 's,\\\\,/,g')\")\n\
             if [ -x \"$basedir/node\" ]; then\n  exec \"$basedir/node\"  \
             \"$basedir/global/5/node_modules/zcode-acp-server/dist/cli.js\" \"$@\"\n\
             else\n  exec node  \"$basedir/global/5/node_modules/zcode-acp-server/dist/cli.js\" \"$@\"\nfi\n",
        )
        .unwrap();
        assert_eq!(bridge_entry(&sh), Some(entry.clone()));
        // pnpm's Windows launcher spells the directory `%~dp0`, npm's `%dp0%`.
        let cmd = dir.path().join("zcode-acp-server.cmd");
        std::fs::write(
            &cmd,
            "@IF EXIST \"%~dp0\\node.exe\" (\r\n  \"%~dp0\\node.exe\"  \
             \"%~dp0\\global\\5\\node_modules\\zcode-acp-server\\dist\\cli.js\" %*\r\n)\r\n",
        )
        .unwrap();
        assert_eq!(bridge_entry(&cmd), Some(entry.clone()));
        assert_eq!(bridge_entry(&entry), Some(entry.clone()));
        // A native shim names no entry; Node cannot run it as the bridge.
        let native = dir.path().join("zcode-acp-native");
        std::fs::write(&native, [0x7f, b'E', b'L', b'F', 0xff, 0xfe]).unwrap();
        assert_eq!(bridge_entry(&native), None);
        assert_eq!(bridge_entry(&dir.path().join("missing")), None);
        // The official CLI may still be a native executable the bridge runs.
        assert_eq!(cli_entry(&native), Some(native.clone()));
    }

    #[test]
    fn node_candidates_put_path_first_and_leave_an_explicit_node_alone() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("Path Bin");
        let path_node = bin.join(if cfg!(windows) { "node.exe" } else { "node" });
        file(&path_node);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path_node, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let env = BTreeMap::from([("PATH".into(), bin.display().to_string())]);
        let found = node_candidates(&env, dir.path(), None, "test").unwrap();
        assert_eq!(found.first(), Some(&path_node));
        let chosen = dir.path().join("Chosen Node/node.exe");
        file(&chosen);
        let mut explicit = env.clone();
        explicit.insert("ZCODE_NODE".into(), chosen.display().to_string());
        assert_eq!(
            node_candidates(&explicit, dir.path(), None, "test").unwrap(),
            vec![chosen]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_old_path_node_does_not_hide_a_version_manager_node() {
        let dir = tempfile::tempdir().unwrap();
        // Each fake answers only the real probe — the script that loads
        // node:sqlite — and fails anything else.
        let fake = |bin: &str, supported: bool| {
            let bin = dir.path().join(bin);
            std::fs::create_dir_all(&bin).unwrap();
            let verdict = if supported { 0 } else { 2 };
            crate::process::write_test_script(
                &bin.join("node"),
                &format!(
                    "#!/bin/sh\ncase \"$2\" in *node:sqlite*) exit {verdict};; esac\nexit 9\n"
                ),
            );
            bin
        };
        let path_bin = fake("Path Node", false);
        let manager_bin = fake("Version Manager/v24.0.0/bin", true);
        let env = BTreeMap::from([("PATH".into(), path_bin.display().to_string())]);
        let candidates =
            discovered_nodes(&env, dir.path(), "test", vec![manager_bin.clone()]).unwrap();
        assert_eq!(
            candidates,
            vec![path_bin.join("node"), manager_bin.join("node")]
        );
        assert_eq!(
            first_supported_node(candidates, env.get("PATH")).await,
            Some(manager_bin.join("node"))
        );
        assert_eq!(
            first_supported_node(vec![path_bin.join("node")], env.get("PATH")).await,
            None
        );
    }

    #[test]
    fn initial_mode_preserves_explicit_choices_and_replaces_stale_preferences() {
        let available = vec!["build".into(), "plan".into(), "yolo".into()];
        assert_eq!(initial_mode(None, &BTreeMap::new(), &available), "build");
        assert_eq!(
            initial_mode(Some("yolo"), &BTreeMap::new(), &available),
            "yolo"
        );
        assert_eq!(
            initial_mode(Some("retired"), &BTreeMap::new(), &available),
            "build"
        );
        let preferred = BTreeMap::from([("mode".into(), "plan".into())]);
        assert_eq!(initial_mode(Some("yolo"), &preferred, &available), "plan");
    }

    #[test]
    fn invalid_node_override_is_reported_instead_of_using_another_node() {
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("zcode.cjs");
        file(&cli);
        let env = BTreeMap::from([
            ("ZCODE_BIN".into(), cli.display().to_string()),
            (
                "ZCODE_NODE".into(),
                dir.path().join("missing-node.exe").display().to_string(),
            ),
        ]);
        assert!(matches!(
            resolve_paths(&env, dir.path(), None, "windows"),
            Err(RuntimeError::NodeInvalid(_))
        ));
    }

    #[test]
    fn a_relative_override_is_refused_rather_than_read_from_one_workspace() {
        let dir = tempfile::tempdir().unwrap();
        // Both exist relative to this cwd, as they might in one workspace.
        let cli = dir.path().join("tools/zcode.cjs");
        let node = dir.path().join("tools/node.exe");
        file(&cli);
        file(&node);
        let refusal = |bin: String, node: String| {
            let env = BTreeMap::from([("ZCODE_BIN".into(), bin), ("ZCODE_NODE".into(), node)]);
            match resolve_paths(&env, dir.path(), None, "test") {
                Err(error) => error.to_string(),
                Ok(runtime) => panic!("a relative override resolved to {runtime:?}"),
            }
        };
        assert_eq!(
            refusal("tools/zcode.cjs".into(), node.display().to_string()),
            "ZCODE_BIN must be an absolute path or a command name on PATH: tools/zcode.cjs"
        );
        assert_eq!(
            refusal(cli.display().to_string(), "./tools/node.exe".into()),
            "ZCODE_NODE must be an absolute path or a command name on PATH: ./tools/node.exe"
        );
        assert!(is_relative_path("~/zcode.cjs"));
        assert!(!is_relative_path("node"));
        // Windows reads a drive without a root against that drive's current
        // folder; elsewhere `C:node.exe` is an ordinary command name.
        assert_eq!(is_relative_path("C:node.exe"), cfg!(windows));
        if cfg!(windows) {
            assert_eq!(
                refusal(cli.display().to_string(), "C:node.exe".into()),
                "ZCODE_NODE must be an absolute path or a command name on PATH: C:node.exe"
            );
        }
        // A command name is still looked up on PATH.
        let bin = dir.path().join("bin");
        let path_node = bin.join(if cfg!(windows) { "node.exe" } else { "node" });
        file(&path_node);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path_node, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let env = BTreeMap::from([
            ("ZCODE_BIN".into(), cli.display().to_string()),
            ("ZCODE_NODE".into(), "node".into()),
            ("PATH".into(), bin.display().to_string()),
        ]);
        assert_eq!(
            resolve_paths(&env, dir.path(), None, "test").unwrap().node,
            path_node
        );
    }

    #[test]
    fn missing_official_runtime_is_distinct_from_missing_bridge() {
        let dir = tempfile::tempdir().unwrap();
        let env = BTreeMap::from([
            ("LOCALAPPDATA".into(), dir.path().display().to_string()),
            ("PATH".into(), String::new()),
        ]);
        assert!(matches!(
            resolve_paths(&env, dir.path(), None, "windows"),
            Err(RuntimeError::CliMissing)
        ));
    }

    #[test]
    fn ordinary_path_installation_is_discovered_with_spaces() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("Command Line Tools");
        let cli = bin.join(if cfg!(windows) { "zcode.exe" } else { "zcode" });
        let node = bin.join(if cfg!(windows) { "node.exe" } else { "node" });
        file(&cli);
        file(&node);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
            std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let env = BTreeMap::from([("PATH".into(), bin.display().to_string())]);
        let runtime = resolve_paths(&env, dir.path(), None, "test").unwrap();
        assert_eq!(runtime.cli, cli);
        assert_eq!(runtime.node, node);
    }

    #[test]
    fn explicit_environment_wins_and_blank_values_remove_inheritance() {
        temp_env::with_vars([("ZCODE_BIN", Some("inherited.cjs"))], || {
            let overrides = BTreeMap::from([("ZCODE_BIN".into(), "chosen.cjs".into())]);
            assert_eq!(
                effective_env(&overrides).get("ZCODE_BIN").unwrap(),
                "chosen.cjs"
            );
            let overrides = BTreeMap::from([
                ("ZCODE_BIN".into(), String::new()),
                ("PATH".into(), String::new()),
            ]);
            let env = effective_env(&overrides);
            assert!(!env.contains_key("ZCODE_BIN"));
            assert_eq!(env.get("PATH"), Some(&String::new()));
        });
    }
}
